# Sound credits and licences

| Files | Used for | Source | Licence |
|---|---|---|---|
| `recordings/tyre_squeal.wav` | Tyre squeal | audible-edge (Tom Haigh), loop edit by qubodup: [Car tire squeal skid loop](https://lpc.opengameart.org/content/car-tire-squeal-skid-loop), [original download](https://lpc.opengameart.org/sites/default/files/tires_squal_loop.wav). Audio edited for this game: selected 0.3–2.0 s, 0.2 s wrap crossfade, resampled to mono 44.1 kHz / 16-bit, DC removed and level normalised. | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) |
| `recordings/impact.wav` | Impact thud | Eldritch Grim: [Impacts/Gun/sfx](https://opengameart.org/content/impactsgunsfx), [original archive](https://opengameart.org/sites/default/files/impacts.zip), `Impacts/Impact 10.wav`. Audio edited for this game: selected 0.04–1.3 s, mono conversion, edge fades, DC removal and level normalisation. | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| `engine_idle.wav`, `engine_low.wav`, `engine_med.wav`, `engine_high.wav` | Hatchback engine | BMW 120d recorded from outside the car by GiocoSound, Freesound pack 22622 ("Car Engine"): sounds 401552 (idle), 401556 (RPM low), 401555 (RPM med), 401551 (RPM high), <https://freesound.org/people/GiocoSound/packs/22622/>; cut to seamless loops by `tools/make_engine_sound.py` | CC0 1.0 (public domain) |
| `engines/race_*.wav` (flat-plane V8), `engines/sports_*.wav` (V10), `engines/suv_*.wav` (V6), `engines/truck_*.wav` (cross-plane V8 diesel), `engines/dirt_*.wav` (2-stroke single), `engines/sport_*.wav` (inline-4), `engines/prop_*.wav` (flat-4 aircraft), `engines/stunt_*.wav` (flat-6 aircraft) | Race car, sports car, SUV, big truck, dirt bike, sport bike, prop plane, stunt plane engines | Synthesised for this game by `tools/make_engine_sounds.py` (exhaust-pulse model; no recordings) | CC0 1.0 (public domain) |
| (no files) | Jet turbines and afterburner, helicopter rotor and turbine, propeller buzz, gear clunk, exhaust crackle, turbo whistle | Synthesised in the browser from noise and oscillators (`game/src/audio/engines.js`) | Part of the game's code |
| (no files) | Tyre squeal and impact fallback, loose ground crunch and pebble ticks, grass swish, wind, rain hiss and body drops, water splash and wading spray, metal crunch, landing thumps | Synthesised in the browser (`game/src/audio/effects.js`): original procedural synthesis; buffers are generated after audio starts, mono, cached per AudioContext and shared by local and remote voices | CC0 1.0 (public domain) |

Each engine loop is mono 16-bit 44.1 kHz WAV, ≤ 110 KB (the synthesised ones ≤ 90 KB, each an exact whole number of
engine cycles, so seamless). A type's loops are loaded only when that vehicle type is first heard.

The two recorded effects are rebuilt with `python tools/make_recorded_effects.py <incoming-directory>`
(numpy/scipy required). They are mono 16-bit 44.1 kHz WAV, each below 150,000 bytes.
The original downloads are not shipped. Recordings load only on first use and are decoded once per audio context;
procedural effects remain available during loading and after a failed download or decode. An impact is never
delayed or replayed when its recording finishes loading. No BY-SA recording is included in this set.
