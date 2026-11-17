"""Synthesise the per-type engine loops in game/assets/audio/engines/ (own work, released CC0; no recordings used).

Every engine is modelled as a train of exhaust pulses: each cylinder fires at its crank angle (firing order and bank
layout per engine), each pulse is a short pressure bump whose width is a fixed crank angle (so it gets shorter as the
engine revs up) rung through a few fixed exhaust / intake resonances (the engine's "voice", same Hz at every rpm),
with small random cycle-to-cycle strength changes, plus combustion noise gated by the same pulses. Everything is built
circularly (FFT), so each loop is an exact whole number of engine cycles and repeats without a seam or a click.

Each type gets 3-5 loops at steady rpms, neighbours at most 2x apart (so no loop is pitched more than ~1.5x); game/src/audio/engines.js plays the two either side of the current rpm, pitch-shifted
(playbackRate = rpm / loop rpm) and crossfaded, like the recorded engine_*.wav set (still used by the hatchback).
Writes game/assets/audio/engines/<type>_<rpm>.wav (mono 16-bit 44.1 kHz: WAV, not MP3/OGG, because MP3 pads the
start and end (an audible gap in a loop) and older Safari can't decode OGG; ≤ 90 KB each) and game/src/audio/engineloops.js (each loop's
file, exact rpm and size).

Run: .venv/bin/python tools/make_engine_sounds.py [type ...]
"""
import glob, json, os, re, sys, wave
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'game/assets/audio')
MANIFEST = os.path.join(ROOT, 'game/src/audio/engineloops.js')
SR = 44100

# cyl: firing angles in crank degrees (one entry per firing, in order) and the bank (exhaust side) each one leaves by;
# width: pulse width in crank degrees; res: (Hz, decay ms, level) exhaust/intake resonances; noise: (centre Hz,
# octaves wide, level, gate ms); jitter: random pulse strength (idle, redline); miss: misfire chance at idle;
# bank: level of each bank as heard; lp: muffler low-pass Hz; layers: loop rpms; secs: loop length (idle, top)
ENGINES = {
    # open-wheel racer: flat-plane V8, each bank fires evenly (180°): a hard, high scream
    'race': dict(stroke=4, cyl=[(i * 90, i % 2) for i in range(8)], bank=(1, .82), width=55,
                 res=[(950, 3, .9), (1900, 1.6, .8), (3600, .8, .45), (5200, .5, .2)], direct=.55,
                 noise=(4200, 1.6, .16, 1.2), jitter=(.12, .04), miss=0, lp=11000,
                 layers=[4000, 7000, 10500], secs=(.75, .5), redline=12500),
    # Lamborghini-style V10 (72° even firing, banks alternate): a deeper, round howl
    'sports': dict(stroke=4, cyl=[(i * 72, i % 2) for i in range(10)], bank=(1, .7), width=70,
                   res=[(420, 5, .9), (1150, 2.4, .75), (2400, 1.1, .4), (3900, .6, .15)], direct=.4,
                   noise=(2600, 1.6, .12, 1.8), jitter=(.1, .05), miss=0, lp=7500,
                   layers=[1000, 2000, 3800, 6000, 8200], secs=(.85, .55), redline=8500),
    # smooth 60° V6 (120° even firing), well muffled
    'suv': dict(stroke=4, cyl=[(i * 120, i % 2) for i in range(6)], bank=(1, .92), width=90,
                res=[(170, 9, 1), (390, 5, .55), (850, 2.5, .25)], direct=.25,
                noise=(900, 1.4, .05, 3), jitter=(.06, .03), miss=0, lp=1900,
                layers=[750, 1500, 3000, 5400], secs=(.9, .6), redline=6200),
    # big truck: cross-plane V8 turbo diesel. Firing order 1-8-4-3-6-5-7-2 leaves the banks L R R L R L L R, so each
    # side's exhaust is uneven: with the near side louder that is the V8 burble / rumble. Diesel knock on top.
    'truck': dict(stroke=4, cyl=[(i * 90, b) for i, b in enumerate([0, 1, 1, 0, 1, 0, 0, 1])], bank=(1, .5), width=95,
                  res=[(85, 16, 1), (210, 8, .6), (480, 3.5, .35), (2600, .5, .12)], direct=.3,
                  noise=(2400, 1.2, .14, .9), jitter=(.1, .05), miss=0, lp=1300,
                  layers=[650, 1250, 2200, 3400], secs=(1.0, .7), redline=3800),
    # dirt bike: 2-stroke single (fires every turn): buzzy expansion-chamber rasp, ring-ding misses at idle
    'dirt': dict(stroke=2, cyl=[(0, 0)], bank=(1,), width=110,
                 res=[(260, 6, 1), (880, 2.6, .75), (2100, 1.2, .5), (4300, .5, .2)], direct=.5,
                 noise=(3200, 1.5, .3, 1.6), jitter=(.22, .08), miss=.07, lp=7000,
                 layers=[1600, 3200, 6000, 10000], secs=(.9, .55), redline=11000),
    # sport bike: inline-4 (180° even firing), intake honk and a high scream
    'sport': dict(stroke=4, cyl=[(i * 180, 0) for i in range(4)], bank=(1,), width=60,
                  res=[(470, 5, .8), (1250, 2, .8), (2700, 1, .5), (4600, .5, .2)], direct=.5,
                  noise=(3600, 1.6, .14, 1.2), jitter=(.1, .04), miss=0, lp=9500,
                  layers=[1300, 2600, 5000, 8500, 12500], secs=(.8, .5), redline=14000),
    # trainer aircraft: flat-4 (180° even), short open stacks: a raspy, throaty drone
    'prop': dict(stroke=4, cyl=[(i * 180, i % 2) for i in range(4)], bank=(1, .85), width=85,
                 res=[(150, 9, 1), (430, 4, .7), (1050, 1.8, .4)], direct=.45,
                 noise=(1500, 1.6, .22, 2.5), jitter=(.1, .06), miss=.01, lp=5000,
                 layers=[800, 1500, 2450], secs=(1.0, .75), redline=2500),
    # aerobatic aircraft: flat-6 (120° even), more power: deeper bark, higher drone at full revs
    'stunt': dict(stroke=4, cyl=[(i * 120, i % 2) for i in range(6)], bank=(1, .8), width=80,
                  res=[(190, 8, 1), (560, 3.5, .7), (1400, 1.5, .45)], direct=.5,
                  noise=(1900, 1.6, .22, 2), jitter=(.1, .05), miss=.01, lp=6000,
                  layers=[850, 1650, 2700], secs=(1.0, .7), redline=2750),
}


def bandpass(x, f, q):
    """RBJ band-pass (0 dB peak), applied forward in time to a short kernel."""
    from scipy.signal import lfilter
    w = 2 * np.pi * f / SR; al = np.sin(w) / (2 * q); c = np.cos(w)
    b = np.array([al, 0, -al]); a = np.array([1 + al, -2 * c, 1 - al])
    return lfilter(b / a[0], a / a[0], x)


def pulse_kernel(e, rpm, frac):
    """One exhaust pulse: a half-sine pressure bump (fixed crank angle) through the engine's resonances."""
    n = int(SR * 0.06)
    w = max(2, int(SR * e['width'] / (6 * rpm)))                 # crank degrees -> samples at this rpm
    p = np.zeros(n); p[:w] = np.sin(np.linspace(0, np.pi, w))
    p -= np.concatenate([[0], p[:-1]]) * 0.6                       # a sharper edge: pressure rises faster than it falls
    k = e['direct'] * p
    for f, ms, lvl in e['res']:
        q = np.pi * f * ms / 1000                                  # decay time -> Q
        lvl *= 0.6 + 0.8 * frac if f > 1500 else 1                 # high resonances open up with revs
        k = k + lvl * bandpass(p, f, max(0.7, q)) * 3
    return k


def render(name, e, rpm_target, secs, seed):
    rng = np.random.default_rng(seed)
    turn = 720 if e['stroke'] == 4 else 360
    cyc = SR * 60 / rpm_target * turn / 360                        # samples per engine cycle
    n_cyc = max(3, round(secs * SR / cyc))
    L = int(round(n_cyc * cyc))
    rpm = n_cyc * SR * 60 * turn / 360 / L                         # exact rpm of the loop
    frac = min(1, max(0, (rpm - e['layers'][0]) / (e['redline'] - e['layers'][0])))
    jit = e['jitter'][0] + (e['jitter'][1] - e['jitter'][0]) * frac
    miss = e['miss'] * (1 - frac) ** 2
    cyl_gain = 1 + 0.05 * rng.standard_normal(len(e['cyl']))       # each cylinder a little different
    times, amps, banks = [], [], []
    start = rng.random()                                           # (no pulse right on the loop point)
    for c in range(n_cyc):
        for i, (ang, bank) in enumerate(e['cyl']):
            times.append((c + start + ang / turn) * L / n_cyc % L)
            a = cyl_gain[i] * e['bank'][bank] * max(0.1, 1 + jit * rng.standard_normal())
            if rng.random() < miss: a *= 0.08
            amps.append(a); banks.append(bank)
    times = np.array(times); amps = np.array(amps)
    # circular impulse train (fractional positions exactly) convolved with the pulse kernel in the frequency domain
    fbin = np.arange(L // 2 + 1)
    train = np.zeros(L // 2 + 1, complex)
    for chunk in range(0, len(times), 64):
        t = times[chunk:chunk + 64]; a = amps[chunk:chunk + 64]
        train += (a[:, None] * np.exp(-2j * np.pi * np.outer(t, fbin) / L)).sum(0)
    kern = pulse_kernel(e, rpm, frac)
    K = np.fft.rfft(np.pad(kern, (0, max(0, L - len(kern))))[:L])
    tone = np.fft.irfft(train * K, L)
    # combustion / flow noise: white noise gated by each pulse's envelope, then band-limited
    fc, octs, lvl, gate_ms = e['noise']
    g = np.exp(-np.arange(int(SR * 0.05)) / (SR * gate_ms / 1000 * (0.6 + 0.8 * (1 - frac))))
    G = np.fft.rfft(np.pad(g, (0, max(0, L - len(g))))[:L])
    env = np.fft.irfft(train * G, L); env = np.maximum(env, 0); env /= env.mean() + 1e-9
    noise = rng.standard_normal(L) * (0.35 + 0.65 * env)
    f = fbin * SR / L
    band = np.exp(-0.5 * (np.log2(np.maximum(f, 1) / fc) / (octs / 2)) ** 2)
    noise = np.fft.irfft(np.fft.rfft(noise) * band, L)
    noise *= lvl * (0.6 + 0.8 * frac) * np.sqrt(np.mean(tone ** 2)) / (np.sqrt(np.mean(noise ** 2)) + 1e-9) * 3
    y = tone + noise
    # muffler low-pass + high-pass (no DC / sub-audio), still circular
    Y = np.fft.rfft(y)
    Y *= 1 / np.sqrt(1 + (f / e['lp']) ** 4) * (f / 25) ** 2 / (1 + (f / 25) ** 2)
    y = np.fft.irfft(Y, L)
    y *= 0.12 / np.sqrt(np.mean(y ** 2))                          # same loudness for every loop
    if np.abs(y).max() > 0.95: y = 0.95 * np.tanh(y / 0.95)          # spiky idles: round the tallest peaks
    return y, rpm


def write_manifest(manifest):
    lines = ['// Generated by tools/make_engine_sounds.py: the engine loops of each vehicle type, the exact rpm each was made at',
             '// (audio/engines.js plays them at playbackRate = rpm / loop rpm) and their size. The hatchback keeps the recorded',
             '// BMW 120d set (tools/make_engine_sound.py) at its true rpms; ENGINES.hatch.pitch maps the game rpm onto them.',
             'export const ENGINE_LOOPS = {']
    for name, layers in manifest.items():
        items = ', '.join(f"{{ file: '{l['file']}', rpm: {l['rpm']}, bytes: {l['bytes']} }}" for l in layers)
        lines.append(f'  {name}: [{items}],')
    lines.append('};')
    open(MANIFEST, 'w').write('\n'.join(lines) + '\n')


def read_manifest():
    if not os.path.exists(MANIFEST):
        return {}
    src = open(MANIFEST).read()
    out = {}
    for name, body in re.findall(r'^  (\w+): \[(.*)\],$', src, re.M):
        out[name] = [{'file': f, 'rpm': float(r), 'bytes': int(b)}
                     for f, r, b in re.findall(r"file: '([^']+)', rpm: ([\d.]+), bytes: (\d+)", body)]
    return out


def main():
    only = set(sys.argv[1:])
    os.makedirs(os.path.join(OUT, 'engines'), exist_ok=True)
    manifest = read_manifest()
    # the recorded hatchback set: a 4-cylinder fires twice a turn, so its true rpm = firing Hz × 30 (engine.json)
    rec = json.load(open(os.path.join(OUT, 'engine.json')))
    manifest['hatch'] = [{'file': f'engine_{n}.wav', 'rpm': rec[n]['hz'] * 30, 'bytes': os.path.getsize(os.path.join(OUT, f'engine_{n}.wav'))}
                         for n in ['idle', 'low', 'med', 'high']]
    for ti, (name, e) in enumerate(ENGINES.items()):
        if only and name not in only:
            continue
        for old in glob.glob(os.path.join(OUT, 'engines', f'{name}_*.wav')):
            os.remove(old)                                         # loops at rpms no longer made
        layers = []
        for li, r in enumerate(e['layers']):
            secs = e['secs'][0] + (e['secs'][1] - e['secs'][0]) * li / (len(e['layers']) - 1)
            y, rpm = render(name, e, r, secs, seed=1000 * ti + li)
            fn = f'engines/{name}_{r}.wav'
            with wave.open(os.path.join(OUT, fn), 'wb') as w:
                w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
                w.writeframes((y * 32767).astype(np.int16).tobytes())
            size = os.path.getsize(os.path.join(OUT, fn))
            # seam check (built circularly, so it should look like any other step): the jump across the loop point
            # as a percentile of the loop's own sample-to-sample steps
            seam = np.mean(np.abs(np.diff(y)) < abs(y[0] - y[-1])) * 100
            X = np.abs(np.fft.rfft(y)); f = np.fft.rfftfreq(len(y), 1 / SR)
            centroid, low = (X * f).sum() / X.sum(), (X[f < 200] ** 2).sum() / (X ** 2).sum()
            layers.append({'file': fn, 'rpm': round(rpm, 2), 'bytes': size})
            print(f'{name:7s} {rpm:8.1f} rpm  {len(y) / SR:.2f} s  {size / 1024:3.0f} KB  peak {np.abs(y).max():.2f}  '
                  f'seam step at {seam:2.0f}th pct  centroid {centroid:5.0f} Hz  below 200 Hz {low * 100:3.0f}%')
        manifest[name] = layers
    order = ['race', 'sports', 'hatch', 'suv', 'truck', 'dirt', 'sport', 'prop', 'stunt']
    write_manifest({k: manifest[k] for k in sorted(manifest, key=lambda k: order.index(k) if k in order else 99)})


if __name__ == '__main__':
    main()
