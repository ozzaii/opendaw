const username = "openDAW"
const password = "prototype"
export const base64Credentials = btoa(`${username}:${password}`)
export const OpenDAWHeaders: RequestInit = {
    method: "GET",
    headers: {"Authorization": `Basic ${base64Credentials}`}
}

// BRAVOH's booth and engine pages are served by BRAVOH's store (bravoh/engine), and openDAW's asset host answers
// cross-origin only to opendaw.studio: those pages read the same files through the store, which fetches them with
// these credentials. Read at import, before the booth or engine takes its token out of the address.
export const ViaBravohStore = /(^|[#&])(booth|engine)=/.test(location.hash)
export const AssetsRoot = ViaBravohStore ? `${location.origin}/opendaw-assets` : "https://assets.opendaw.studio"
