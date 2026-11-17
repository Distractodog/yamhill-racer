# Sound credits and licences

| Files | Used for | Source | Licence |
|---|---|---|---|
| `recordings/race_*.wav` | Race car (Ferrari road-car V8 recording) | enginemusic: [Ferrari F355 under-hood exhaust sound](https://commons.wikimedia.org/wiki/File:Ferrari_F355_under-hood_exhaust_sound.ogg). Three selected segments, high-pass filtered, loop-crossfaded, pitch-rendered and normalised for this game. | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) |
| `recordings/hatch_*.wav` | Hatchback | MKFI: [Open Corsa E model 2014 engine startup sound](https://commons.wikimedia.org/wiki/File:Open_Corsa_E_model_2014_engine_startup_sound.ogg). Short settling tail looped, filtered, pitch-rendered to four audio rpm anchors and normalised. | Public domain (author's worldwide dedication on the file page) |
| `recordings/suv_*.wav` | SUV (Volvo five-cylinder recording) | Jonas Tittmann / LM7805: [5 cylinder engine sound](https://commons.wikimedia.org/wiki/File:5_cylinder_engine_sound.ogg). Three selected segments, filtered and looped; four pitch-rendered layers. Audio edited for the game, shared under the same licence. | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) |
| `recordings/prop_*.wav` | Prop plane (Ford TriMotor radial recording) | Alexf: [EAA Ford TriMotor NC8407](https://commons.wikimedia.org/wiki/File:EAA_Ford_TriMotor_NC8407.ogg). One filtered loop rendered at three pitch anchors and normalised. Audio edited for the game, shared under the same licence. | [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/) |
| `recordings/heli_rotor.wav` | Helicopter rotor | ezwa / PDSounds: [Helicopter over quiet neighbourhood](https://commons.wikimedia.org/wiki/File:Helicopter_over_quiet_n.ogg). Selected, high-pass filtered, loop-crossfaded and normalised. | Public domain (author's worldwide dedication on the file page) |
| `recordings/rain.wav` | Rain | cori / Cori Samuel / PDSounds: [Rain against the window](https://commons.wikimedia.org/wiki/File:Rain_against_the_window.ogg). Selected, high-pass filtered at 180 Hz to reduce wind rumble, loop-crossfaded and normalised. | Public domain (author's worldwide dedication on the file page) |
| `recordings/tyre_squeal.wav` | Tyre squeal | audible-edge (Tom Haigh), loop edit by qubodup: [Car tire squeal skid loop](https://lpc.opengameart.org/content/car-tire-squeal-skid-loop), [original download](https://lpc.opengameart.org/sites/default/files/tires_squal_loop.wav). Audio edited for this game: selected 0.3–2.0 s, 0.2 s wrap crossfade, resampled to mono 44.1 kHz / 16-bit, DC removed and level normalised. | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) |
| `recordings/impact.wav` | Impact thud | Eldritch Grim: [Impacts/Gun/sfx](https://opengameart.org/content/impactsgunsfx), [original archive](https://opengameart.org/sites/default/files/impacts.zip), `Impacts/Impact 10.wav`. Audio edited for this game: selected 0.04–1.3 s, mono conversion, edge fades, DC removal and level normalisation. | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| `engine_idle.wav`, `engine_low.wav`, `engine_med.wav`, `engine_high.wav` | Hatchback fallback | BMW 120d recorded from outside the car by GiocoSound, Freesound pack 22622 ("Car Engine"): sounds 401552 (idle), 401556 (RPM low), 401555 (RPM med), 401551 (RPM high), <https://freesound.org/people/GiocoSound/packs/22622/>; cut to seamless loops by `tools/make_engine_sound.py` | CC0 1.0 (public domain) |
| `engines/race_*.wav` (flat-plane V8), `engines/sports_*.wav` (V10), `engines/suv_*.wav` (V6), `engines/truck_*.wav` (cross-plane V8 diesel), `engines/dirt_*.wav` (2-stroke single), `engines/sport_*.wav` (inline-4), `engines/prop_*.wav` (flat-4 aircraft), `engines/stunt_*.wav` (flat-6 aircraft) | Race car, sports car, SUV, big truck, dirt bike, sport bike, prop plane, stunt plane engines | Synthesised for this game by `tools/make_engine_sounds.py` (exhaust-pulse model; no recordings) | CC0 1.0 (public domain) |
| (no files) | Jet turbines and afterburner, helicopter rotor fallback and turbine, propeller buzz, gear clunk, exhaust crackle, turbo whistle | Synthesised in the browser from noise and oscillators (`game/src/audio/engines.js`) | Part of the game's code |
| (no files) | Tyre squeal, impact and rain fallback, loose ground crunch and pebble ticks, grass swish, wind, rain body drops, water splash and wading spray, metal crunch, landing thumps | Synthesised in the browser (`game/src/audio/effects.js`): original procedural synthesis; buffers are generated after audio starts, mono, cached per AudioContext and shared by local and remote voices | CC0 1.0 (public domain) |

Every recorded loop is mono 16-bit 44.1 kHz WAV, below 150,000 bytes. A type's loops are loaded only when
that vehicle type is first heard. Original engine files remain available as complete fallback sets if a
recording fails to load/decode; the original gear/rpm/pitch mapping is unchanged.

Tyre and impact are rebuilt with `python tools/make_recorded_effects.py <incoming-directory>`.
Engines, rotor and rain are rebuilt with `python tools/make_recorded_engines.py <incoming-directory>`
(numpy/scipy required; run through the heavy gate). Source hashes, selected times and filter settings are
in `recordings/processing.json`. Source rpm estimates come from spectral peaks, not tachometer readings.
The hatch and prop layers are pitch variants of single loops; the race car and SUV use three source segments.
The original downloads are not shipped. Recordings load only on first use and are decoded once per audio context;
procedural effects remain available during loading and after a failed download or decode. An impact is never
delayed or replayed when its recording finishes loading.

The supplied Lexus LFA recording was not included: its revving sections contain full-scale clipping
(over 3% of samples in one 0.18-second section). The sports car retains its original synthesis.
Truck, bikes, jets and stunt plane also retain their original sounds. Listening quality and final mix
balance require in-game review; waveform/loop checks alone cannot establish audible improvement.
