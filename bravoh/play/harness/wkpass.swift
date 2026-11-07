// A whole pass in a plain WKWebView, the WebKit the Mac app runs on: the spike page, no driver polling. `wkpass <url> <seconds> [control]`
import Cocoa
import WebKit
let url = URL(string: CommandLine.arguments[1])!, seconds = Double(CommandLine.arguments[2])!, control = CommandLine.arguments.count > 3
let config = WKWebViewConfiguration(); config.mediaTypesRequiringUserActionForPlayback = []
let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 400, height: 300), configuration: config)
let window = NSWindow(contentRect: web.frame, styleMask: [.titled], backing: .buffered, defer: false); window.contentView = web; window.orderFront(nil)
func js(_ body: String, _ done: @escaping (Any?) -> Void) {
  web.callAsyncJavaScript(body, arguments: [:], in: nil, in: .page) { r in
    switch r { case .success(let v): done(v); case .failure(let e): print("js error", e); exit(2) } }
}
func json(_ v: Any?) -> String { guard let v, JSONSerialization.isValidJSONObject(v), let d = try? JSONSerialization.data(withJSONObject: v) else { return String(describing: v) }; return String(data: d, encoding: .utf8)! }
final class Nav: NSObject, WKNavigationDelegate {
  func webView(_ w: WKWebView, didFinish n: WKNavigation!) {
    DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
      js(control ? "document.querySelector('#go').click(); return await window.np.joined" : "return await window.np.joined") { joined in
        print("joined", json(joined)); print("coi"); fflush(stdout)
        js("return {coi: crossOriginIsolated, ctx: window.np.context()}") { c in print(json(c)); fflush(stdout)
          js("const q = window.np.now(); \(control ? "" : "window.np.play(0);") return q") { q0 in
            DispatchQueue.main.asyncAfter(deadline: .now() + seconds) {
              let q = (q0 as? NSNumber)?.intValue ?? 0
              js("const e = window.np.now() - 1, a = window.np.stamp(\(q)), z = window.np.stamp(e); const audio = (e - \(q)) * 128 / 48000; return {audioSec: audio, wallSec: (z - a) / 1000, lostMs: Math.round((z - a) - audio * 1000), stalls30: window.np.stalls(\(q), 30).map(s => s.ms), ctx: window.np.context()}") { r in
                print(json(r)); fflush(stdout); exit(0)
              }
            }
          }
        }
      }
    }
  }
}
let nav = Nav(); web.navigationDelegate = nav
NSApplication.shared.setActivationPolicy(.accessory)
web.load(URLRequest(url: url))
DispatchQueue.main.asyncAfter(deadline: .now() + seconds + 120) { print("timeout"); exit(1) }
NSApplication.shared.run()
