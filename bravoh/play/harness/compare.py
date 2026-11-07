# /// script
# dependencies = ["numpy", "scipy"]
# ///
"""Is it the same sound? Two float signals, aligned to the sample, then what is left when one is subtracted from the other."""
import sys, numpy as np, wave, struct
from scipy.signal import fftconvolve
def load(path):
    if path.endswith(".f32"):
        return np.fromfile(path, dtype="<f4").reshape(-1, 2)
    b = open(path, "rb").read()
    i = b.find(b"data")
    n = struct.unpack("<I", b[i+4:i+8])[0]
    return np.frombuffer(b, dtype="<f4", count=n//4, offset=i+8).reshape(-1, 2)
db = lambda v: 20*np.log10(max(float(v), 1e-12))
rms = lambda x: float(np.sqrt(np.mean(x*x))) if x.size else 0.0
a, b = load(sys.argv[1]), load(sys.argv[2])
print("frames", len(a), len(b), "seconds", len(a)/48000, len(b)/48000, "peak", db(np.abs(a).max()), db(np.abs(b).max()), "rms", db(rms(a)), db(rms(b)))
# align on a stretch of the song that has sound, in mono
start = 48000*20; size = 48000*8
ma, mb = a[:,0]+a[:,1], b[:,0]+b[:,1]
seg = mb[start:start+size]
lo = max(0, start-48000*5); hi = start+size+48000*5
corr = fftconvolve(ma[lo:hi], seg[::-1], mode="valid")
lag = int(np.argmax(np.abs(corr))) + lo - start
print("lag (a later than b) frames", lag, "ms", lag/48)
if lag >= 0: a2, b2 = a[lag:], b
else: a2, b2 = a, b[-lag:]
n = min(len(a2), len(b2)); a2, b2 = a2[:n], b2[:n]
d = a2-b2
print("overall null dB rel signal", db(rms(d))-db(rms(b2)), "residual rms dBFS", db(rms(d)), "peak residual dBFS", db(np.abs(d).max()))
g = float(np.sum(a2*b2)/np.sum(b2*b2)); print("best gain a/b", g, "dB", db(g))
d2 = a2-g*b2; print("after gain null dB", db(rms(d2))-db(rms(b2)))
print("corr", float(np.corrcoef(a2.ravel()[::7], b2.ravel()[::7])[0,1]))
sec = 48000*8
rows = []
for i in range(0, n, sec):
    s = b2[i:i+sec]; r = d[i:i+sec]
    rows.append((i//48000, db(rms(s)), db(rms(r))))
print("t, level dBFS, residual dBFS"); 
for t, s, r in rows: print(f"{t:4d} {s:7.1f} {r:7.1f} {r-s:7.1f}")
# fine alignment: does a sub-sample or drifting offset explain it? residual lag in chunks
print("per-chunk lag (frames)")
for at in range(48000*10, n-48000*6, 48000*40):
    s1, s2 = a2[at:at+48000*4,0], b2[at:at+48000*4,0]
    c = fftconvolve(s1, s2[47:-47][::-1], mode="valid")
    print(at//48000, int(np.argmax(np.abs(c)))-47, end="; ")
print()
