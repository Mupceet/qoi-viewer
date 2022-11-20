import * as vscode from "vscode";
import generateHTMLCanvas from "./webview";
import parse from "./parsing";
import { imagePreviewProviderViewType } from "./const";

class ImagePreviewDocument
  extends vscode.Disposable
  implements vscode.CustomDocument
{
  readonly uri: vscode.Uri;
  private documentData: Uint8Array;

  static async create(uri: vscode.Uri) {
    const fileData = await vscode.workspace.fs.readFile(uri);
    return new ImagePreviewDocument(uri, fileData);
  }

  private constructor(uri: vscode.Uri, initialData: Uint8Array) {
    super(() => {});
    this.uri = uri;
    this.documentData = initialData;
  }

  public get getDocumentData() {
    return this.documentData;
  }

  public get imageData() {
    return parse.parseByteFormat(this.getDocumentData);
  }

  dispose() {
    super.dispose();
  }
}

export default class ImagePreviewProvider
  implements vscode.CustomReadonlyEditorProvider<ImagePreviewDocument>
{
  private static viewType = imagePreviewProviderViewType;

  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      ImagePreviewProvider.viewType,
      new ImagePreviewProvider(context),
      {
        supportsMultipleEditorsPerDocument: false,
        webviewOptions: {
          retainContextWhenHidden: true,
        },
      }
    );
  }

  constructor(private readonly _context: vscode.ExtensionContext) {}

  async openCustomDocument(
    uri: vscode.Uri,
    _openContext: {},
    _token: vscode.CancellationToken
  ): Promise<ImagePreviewDocument> {
    const document = await ImagePreviewDocument.create(uri);
    return document;
  }

  private _createWebView(
    newDocument: ImagePreviewDocument,
    webviewPanel: vscode.WebviewPanel
  ) {
    let data = newDocument.imageData;
    if (data.status === parse.parseStatus.success) {
      webviewPanel.webview.html = generateHTMLCanvas(
        JSON.stringify(data),
        data.width || 0,
        data.height || 0,
        data.imgType || "",
        webviewPanel.title
      );
    }
  }

  private _updateWebView(
    newDocument: ImagePreviewDocument,
    webviewPanel: vscode.WebviewPanel
  ) {
    const { status } = newDocument.imageData;
    if (status === parse.parseStatus.success) {
      webviewPanel.webview.postMessage(newDocument.imageData);
    }
  }

  async resolveCustomEditor(
    document: ImagePreviewDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    webviewPanel.webview.options = {
      enableScripts: true,
    };
    this._createWebView(document, webviewPanel);

    const relativePath = vscode.workspace.asRelativePath(document.uri);
    let watcher = vscode.workspace.createFileSystemWatcher("**/" + relativePath);  // possible to match another image
    const changeFileSubscription = watcher.onDidChange(async (e) => {
      if (document.uri.path === e.path) {  // filter an event
        const newDocument = await ImagePreviewDocument.create(
          vscode.Uri.parse(e.path)
        );
        this._updateWebView(newDocument, webviewPanel);
      }
    });

    webviewPanel.onDidDispose(() => {
      changeFileSubscription.dispose();
    });
  }
}
