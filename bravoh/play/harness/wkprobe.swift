// What a shell's WebKit gives an engine page: a WKWebView, on real https/localhost, and on a custom scheme as Tauri's
// wry serves tauri://localhost (WKURLSchemeHandler) with and without COOP/COEP. Prints what each page reports, then exits.
import Cocoa
import WebKit
final class Scheme: NSObject, WKURLSchemeHandler {
  let isolated: Bool
  init(isolated: Bool) { self.isolated = isolated }
  func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
    let html = "<!doctype html><title>x</title>ok".data(using: .utf8)!
    var headers = ["Content-Type": "text/html", "Content-Length": String(html.count)]
    if isolated { headers["Cross-Origin-Opener-Policy"] = "same-origin"; headers["Cross-Origin-Embedder-Policy"] = "require-corp" }
    task.didReceive(HTTPURLResponse(url: task.request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!)
    task.didReceive(html); task.didFinish()
  }
  func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}
final class Probe: NSObject, WKNavigationDelegate {
  var webs: [WKWebView] = []
  var pending: [(String, () -> WKWebView)] = []
  let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 300), styleMask: [.titled], backing: .buffered, defer: false)
  func next() {
    guard !pending.isEmpty else { DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { NSApp.terminate(nil) }; return }
    let (label, make) = pending.removeFirst(); let web = make(); webs.append(web); web.navigationDelegate = self
    window.contentView = web; web.accessibilityLabel(); labelNow = label
  }
  var labelNow = ""
  func webView(_ web: WKWebView, didFinish nav: WKNavigation!) {
    web.evaluateJavaScript("JSON.stringify({coi: self.crossOriginIsolated, sab: typeof SharedArrayBuffer, secure: isSecureContext, ctx: typeof AudioContext, worklet: typeof AudioWorkletNode, opfs: !!(navigator.storage && navigator.storage.getDirectory), origin: location.origin})") { r, e in
      print(self.labelNow, r ?? e ?? "nil"); fflush(stdout); self.next()
    }
  }
  func webView(_ web: WKWebView, didFail nav: WKNavigation!, withError e: Error) { print(labelNow, "failed", e); self.next() }
  func webView(_ web: WKWebView, didFailProvisionalNavigation nav: WKNavigation!, withError e: Error) { print(labelNow, "failed", e); self.next() }
}
let app = NSApplication.shared
let probe = Probe()
let url = URL(string: CommandLine.arguments.dropFirst().first ?? "http://localhost:7791/booth/")!
probe.pending = [
  ("tauri-like scheme, no headers", { let c = WKWebViewConfiguration(); c.setURLSchemeHandler(Scheme(isolated: false), forURLScheme: "tauri"); let w = WKWebView(frame: .zero, configuration: c); w.load(URLRequest(url: URL(string: "tauri://localhost/")!)); return w }),
  ("tauri-like scheme, COOP+COEP", { let c = WKWebViewConfiguration(); c.setURLSchemeHandler(Scheme(isolated: true), forURLScheme: "tauri"); let w = WKWebView(frame: .zero, configuration: c); w.load(URLRequest(url: URL(string: "tauri://localhost/")!)); return w }),
  ("http localhost, COOP+COEP", { let w = WKWebView(frame: .zero, configuration: WKWebViewConfiguration()); w.load(URLRequest(url: url)); return w }),
]
app.setActivationPolicy(.accessory)
probe.next()
DispatchQueue.main.asyncAfter(deadline: .now() + 40) { print("timeout"); exit(1) }
app.run()
