"""Build the engine sound loops in game/assets/audio/ from real recordings.

Source: GiocoSound's "Car Engine" pack on Freesound (BMW 120d, recorded from outside the car), CC0 / public domain:
  401552 Outside_Idle (~28 Hz firing), 401556 Outside_RPMLow (~49 Hz), 401555 Outside_RPMMed (~68 Hz),
  401551 Outside_RPMHigh (~85 Hz)   https://freesound.org/people/GiocoSound/packs/22622/
The public HQ previews are downloaded to data/raw/engine/ (macOS `afconvert` decodes them).

Each recording is cut to a seamless loop: a section from the middle whose length is a whole number of engine
cycles, with the loop point picked where the waveform lines up best and a short crossfade over the seam. All loops
are levelled to the same loudness. audio.js plays the four at once, pitch-shifting and crossfading by rpm.

Run: .venv/bin/python tools/make_engine_sound.py
"""
import json, os, re, subprocess, urllib.request, wave
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, 'data/raw/engine')
OUT = os.path.join(ROOT, 'game/assets/audio')
SR = 44100
LAYERS = [('idle', 401552, 28.0), ('low', 401556, 49.0), ('med', 401555, 68.0), ('high', 401551, 85.0)]
UA = {'User-Agent': 'Mozilla/5.0'}


def fetch(sid):
    mp3 = os.path.join(RAW, f'{sid}.mp3')
    if not os.path.exists(mp3):
        page = urllib.request.urlopen(urllib.request.Request(f'https://freesound.org/s/{sid}/', headers=UA)).read().decode()
        url = re.search(r'https://cdn\.freesound\.org/previews/[^"]+-hq\.mp3', page).group(0)
        open(mp3, 'wb').write(urllib.request.urlopen(urllib.request.Request(url, headers=UA)).read())
    wav = mp3[:-4] + '.wav'
    if not os.path.exists(wav):
        subprocess.run(['afconvert', '-f', 'WAVE', '-d', f'LEI16@{SR}', '-c', '1', mp3, wav], check=True)
    w = wave.open(wav)
    return np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float64) / 32768


def make_loop(x, f0, cycles_target=1.2, fade=0.05):
    x = x - np.convolve(x, np.ones(2048) / 2048, 'same')         # remove any DC drift
    period = SR / f0
    # an even number of cycles (a 4-cylinder fires twice per revolution; the full pattern repeats every 2)
    n_cyc = 2 * round(cycles_target * f0 / 2)
    L = int(round(n_cyc * period))
    F = int(SR * fade)
    # search start points across the steady part of the file and lengths near the nominal one for the best seam
    best = None
    starts = range(int(0.15 * SR) + F, len(x) - L - int(period) - F - int(0.1 * SR), int(period / 4))
    for a0 in starts:
        for dl in range(-int(period * 0.3), int(period * 0.3) + 1, 2):
            Ld = L + dl
            seg_end = x[a0 + Ld - F: a0 + Ld + F]
            seg_beg = x[a0 - F: a0 + F]
            if len(seg_end) != 2 * F or len(seg_beg) != 2 * F:
                continue
            err = np.mean((seg_end - seg_beg) ** 2) / (np.mean(seg_beg ** 2) + 1e-9)
            if best is None or err < best[0]:
                best = (err, Ld, a0)
    err, L, a = best
    loop = x[a:a + L].copy()
    # crossfade: blend the audio just before the start into the loop's tail (equal power)
    t = np.linspace(0, 1, F)
    pre = x[a - F:a]
    loop[-F:] = loop[-F:] * np.cos(t * np.pi / 2) + pre * np.sin(t * np.pi / 2)
    return loop, err


def main():
    os.makedirs(RAW, exist_ok=True); os.makedirs(OUT, exist_ok=True)
    info = {}
    for name, sid, f0 in LAYERS:
        x = fetch(sid)
        loop, err = make_loop(x, f0)
        loop *= 0.12 / np.sqrt(np.mean(loop ** 2))                # same loudness for every layer
        loop = np.clip(loop, -1, 1)
        with wave.open(os.path.join(OUT, f'engine_{name}.wav'), 'wb') as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
            w.writeframes((loop * 32767).astype(np.int16).tobytes())
        info[name] = {'freesound': sid, 'hz': f0}
        print(f'{name:5s} {len(loop) / SR:.2f}s seam error {err:.3f}  peak {np.abs(loop).max():.2f}')
    json.dump(info, open(os.path.join(OUT, 'engine.json'), 'w'), indent=1)


if __name__ == '__main__':
    main()
