# Sound credits and licences

| Files | Used for | Source | Licence |
|---|---|---|---|
| `engine_idle.wav`, `engine_low.wav`, `engine_med.wav`, `engine_high.wav` | Hatchback engine | BMW 120d recorded from outside the car by GiocoSound, Freesound pack 22622 ("Car Engine"): sounds 401552 (idle), 401556 (RPM low), 401555 (RPM med), 401551 (RPM high), <https://freesound.org/people/GiocoSound/packs/22622/>; cut to seamless loops by `tools/make_engine_sound.py` | CC0 1.0 (public domain) |
| `engines/race_*.wav` (flat-plane V8), `engines/sports_*.wav` (V10), `engines/suv_*.wav` (V6), `engines/truck_*.wav` (cross-plane V8 diesel), `engines/dirt_*.wav` (2-stroke single), `engines/sport_*.wav` (inline-4), `engines/prop_*.wav` (flat-4 aircraft), `engines/stunt_*.wav` (flat-6 aircraft) | Race car, sports car, SUV, big truck, dirt bike, sport bike, prop plane, stunt plane engines | Synthesised for this game by `tools/make_engine_sounds.py` (exhaust-pulse model; no recordings) | CC0 1.0 (public domain) |
| (no files) | Jet turbines and afterburner, helicopter rotor and turbine, propeller buzz, gear clunk, exhaust crackle, turbo whistle | Synthesised in the browser from noise and oscillators (`game/src/audio/engines.js`) | Part of the game's code |
| (no files) | Tyre squeal, loose ground crunch and pebble ticks, grass swish, wind, rain hiss and body drops, water splash and wading spray, impact thuds, metal crunch, landing thumps | Synthesised in the browser (`game/src/audio/effects.js`): original procedural synthesis; buffers are generated lazily after audio starts, mono, cached per AudioContext and shared by local and remote voices; no files are downloaded | CC0 1.0 (public domain) |

Each engine loop is mono 16-bit 44.1 kHz WAV, ≤ 110 KB (the synthesised ones ≤ 90 KB, each an exact whole number of
engine cycles, so seamless). A type's loops are loaded only when that vehicle type is first heard.
