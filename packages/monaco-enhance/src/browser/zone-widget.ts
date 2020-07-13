import { Disposable, IDisposable, Event, Emitter, IRange } from '@ali/ide-core-common';
// import * as styles from './styles.module.less';

export class ViewZoneDelegate implements monaco.editor.IViewZone {
  public domNode: HTMLElement;
  public id: number = 0; // A valid zone id should be greater than 0
  public afterLineNumber: number;
  public afterColumn: number;
  public heightInLines: number;

  private readonly _onDomNodeTop: (top: number) => void;
  private readonly _onComputedHeight: (height: number) => void;

  constructor(domNode: HTMLElement, afterLineNumber: number, afterColumn: number, heightInLines: number, onDomNodeTop: (top: number) => void, onComputedHeight: (height: number) => void) {
    this.domNode = domNode;
    this.afterLineNumber = afterLineNumber;
    this.afterColumn = afterColumn;
    this.heightInLines = heightInLines;
    this._onDomNodeTop = onDomNodeTop;
    this._onComputedHeight = onComputedHeight;
  }

  public onDomNodeTop(top: number): void {
    this._onDomNodeTop(top);
  }

  public onComputedHeight(height: number): void {
    this._onComputedHeight(height);
  }
}

export class OverlayWidgetDelegate extends Disposable implements monaco.editor.IOverlayWidget {

  static id = 'monaco-enhance-overlay-widget';

  constructor(
    readonly id: string,
    readonly dom: HTMLDivElement,
  ) {
    super();
  }

  getPosition() {
    return null;
  }

  getDomNode() {
    return this.dom;
  }

  getId() {
    return this.id;
  }
}

/**
 * 构造函数负责 dom 结构，
 * show 负责 class 注入，
 * render 负责 style 动态注入，
 * dispose 负责回收。
 */
export abstract class ZoneWidget extends Disposable {
  protected _container: HTMLDivElement;

  // 宽度和左定位不需要继承下去，完全交给父容器控制
  private width: number = 0;
  private left: number = 0;
  private _overlay: OverlayWidgetDelegate | null;
  private _viewZone: ViewZoneDelegate | null;
  private _current: monaco.IRange;
  private _linesCount: number;

  constructor(
    protected readonly editor: monaco.editor.ICodeEditor,
  ) {
    super();
    this._container = document.createElement('div');
    this._listenEvents();
  }

  protected abstract applyClass(): void;
  protected abstract applyStyle(): void;

  private _showImpl(where: monaco.IRange, heightInLines: number) {
    const { startLineNumber: lineNumber, startColumn: column } = where;
    const viewZoneDomNode = document.createElement('div');
    const layoutInfo = this.editor.getLayoutInfo();
    viewZoneDomNode.style.overflow = 'hidden';

    this.editor.changeViewZones((accessor) => {
      if (this._viewZone) {
        accessor.removeZone(this._viewZone.id);
        this._viewZone = null;
      }
      if (this._overlay) {
        this.editor.removeOverlayWidget(this._overlay);
        this._overlay = null;
      }
      this._container.style.top = '-1000px';
      this._viewZone = new ViewZoneDelegate(
        viewZoneDomNode,
        lineNumber, column,
        heightInLines,
        (top: number) => this._onViewZoneTop(top),
        (height: number) => this._onViewZoneHeight(height),
      );
      this._viewZone.id = accessor.addZone(this._viewZone);
      this._overlay = new OverlayWidgetDelegate(OverlayWidgetDelegate.id + this._viewZone.id, this._container);
      this.editor.addOverlayWidget(this._overlay);
    });

    this.layout(layoutInfo);
  }

  get currentRange() {
    return this._current;
  }

  get currentHeightInLines() {
    return this._linesCount;
  }

  show(where: monaco.IRange, heightInLines: number) {
    this._current = where;
    this._linesCount = heightInLines;
    this.applyClass();
    this._showImpl(where, heightInLines);
  }

  hide() {
  }

  private _getLeft(info: monaco.editor.EditorLayoutInfo): number {
    if (info.minimapWidth > 0 && info.minimapLeft === 0) {
      return info.minimapWidth;
    }
    return 0;
  }

  private _getWidth(info: monaco.editor.EditorLayoutInfo): number {
    return info.width - info.minimapWidth - info.verticalScrollbarWidth;
  }

  protected _onViewZoneTop(top: number): void {
    this._container.style.top = `${top}px`;
  }

  protected _onViewZoneHeight(height: number): void {
    this._container.style.height = `${height}px`;
  }

  layout(layoutInfo: monaco.editor.EditorLayoutInfo) {
    this.left = this._getLeft(layoutInfo);
    this.width = this._getWidth(layoutInfo);
    this.render();
  }

  render() {
    this._container.style.width = `${this.width}px`;
    this._container.style.left = `${this.left}px`;
    this.applyStyle();
  }

  protected _relayout(newHeightInLines: number): void {
    if (this._viewZone && this._viewZone.heightInLines !== newHeightInLines) {
      this.editor.changeViewZones((accessor) => {
        if (this._viewZone) {
          this._viewZone.heightInLines = newHeightInLines;
          accessor.layoutZone(this._viewZone.id);
        }
      });
    }
  }

  private _listenEvents() {
    this.editor.onDidLayoutChange((event) => {
      this.layout(event);
    });
  }

  dispose() {
    if (this._viewZone) {
      this.editor.changeViewZones((accessor) => {
        if (this._viewZone) {
          accessor.removeZone(this._viewZone.id);
          this._viewZone = null;
        }
      });
    }
    if (this._overlay) {
      this.editor.removeOverlayWidget(this._overlay);
      this._overlay = null;
    }
    this._container.remove();
    super.dispose();
  }
}

/**
 * 可以自适应高度的 ZoneWidget
 */
export abstract class ResizeZoneWidget extends ZoneWidget {

  private preWrapperHeight: number;
  private heightInLines: number;
  private lineHeight: number;
  private wrap: HTMLDivElement;
  protected readonly _onChangeZoneWidget = new Emitter<IRange>();
  public readonly onChangeZoneWidget: Event<IRange> = this._onChangeZoneWidget.event;

  protected _isShow = false;

  constructor(
    protected readonly editor: monaco.editor.ICodeEditor,
    private range: monaco.IRange,
  ) {
    super(editor);
    this.lineHeight = this.editor.getConfiguration().lineHeight;
    this.addDispose(this.editor.onDidChangeConfiguration((e) => {
      if (e.lineHeight) {
        this.lineHeight = this.editor.getConfiguration().lineHeight;
        if (this.wrap) {
          this.resizeZoneWidget();
        }
      }
    }));
  }

  protected observeContainer(dom: HTMLDivElement): IDisposable {
    this.wrap = dom;
    const mutationObserver = new MutationObserver((mutation) => {
      this.resizeZoneWidget();
    });
    mutationObserver.observe(this.wrap, {childList: true, subtree: true});
    return {
      dispose() {
        mutationObserver.disconnect();
      },
    };
  }

  protected resizeZoneWidget() {
    let wrapperHeight = this.wrap.offsetHeight;
    // 可能在设置页设置的时候 editor 不可见，获取的高度为 0
    if (!wrapperHeight && this.preWrapperHeight) {
      wrapperHeight = this.preWrapperHeight;
    }
    if (wrapperHeight) {
      const heightInLines = wrapperHeight / this.lineHeight;
      if (this._isShow && this.heightInLines !== heightInLines) {
        this.heightInLines = heightInLines;
        this.show();
        this.preWrapperHeight = wrapperHeight;
      }
    }
  }

  public show() {
    const needResize = !this.wrap.offsetHeight && !this.preWrapperHeight;
    this.resize();
    this.fireChangeEvent();
    // 如果默认为隐藏，打开后是没有 this.heightInLines 的，需要显示后再计算一下
    if (needResize) {
      this.resizeZoneWidget();
    }
  }

  private fireChangeEvent() {
    this._onChangeZoneWidget.fire(this.range);
  }

  public resize() {
    const activeElement = document.activeElement as HTMLElement;
    super.show(this.range, this.heightInLines);
    // reset focus on the previously active element.
    activeElement?.focus({ preventScroll: true });
  }
}
