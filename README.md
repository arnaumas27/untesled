# Untesled

An engine for your Tesla. Untesled is a static web app that runs in the
Tesla's browser and plays a synthesized engine through the car's speakers:
by default a 4.0-litre, 9,000 rpm, GT3-style flat six, or, if you prefer, a
70s V8, a superbike, a jet engine, a sci-fi space freighter or a horse and
carriage. It reacts to how you actually drive: the car's GPS gives the speed,
and your phone's accelerometer gives an instant throttle.

![Car screen while accelerating, phone in the Tesla dock: 3rd gear, 125 km/h, 7,000 rpm](docs/screenshot-driving.png)

| Pairing (first screen) | Phone, connected |
| --- | --- |
| ![Pairing screen with QR code](docs/screenshot-pairing.png) | ![Phone page connected to the car](docs/screenshot-phone.png) |

- **Six sounds, no audio files.** Every sound is synthesized live in the
  browser: firing pulses, exhaust pipes, intake howl, shift cuts, blips, pops
  and bangs, a turbofan spooling up, hooves on the road. Each sound has its
  own neon artwork and its own dial.
- **Scan and go.** The car shows a QR code. Scan it with your phone camera,
  tap Connect, done. It works on any network, with no app and no account.
- **Works without the phone, too.** On GPS alone the engine follows your
  speed about a second late. The phone makes it instant.
- **Plain HTML, CSS and JavaScript.** No framework, no build step, no runtime
  dependencies. Deploy the folder as it is.

## How it works

```mermaid
flowchart LR
  P["Phone<br/>accelerometer, 25 Hz"] -- "MQTT over wss<br/>(public relay)" --> F
  G["Car GPS<br/>speed, ~1 Hz"] --> F["Sensor fusion<br/>speed + acceleration"]
  F --> V["Virtual drivetrain<br/>of the chosen sound:<br/>gears, rpm, load…"]
  V --> S["Synth<br/>AudioWorklet"]
  S --> SP(("Car speakers"))
```

1. The phone streams its motion through a free public MQTT relay to the car.
   Nothing to host: the site is static, and both sides connect to several
   relays at once and use whichever answers first.
2. The car fuses that with its own GPS. GPS is the truth for speed, and the
   phone is the truth for acceleration (it reacts within about 0.1–0.2 s).
3. A virtual drivetrain (for the flat six, a 7-speed dual-clutch gearbox)
   turns speed and acceleration into gear, rpm and throttle, then feeds the
   synth.

## Use it in the car

1. Open your site (for example `https://yourdomain.com`) in the Tesla browser.
2. Allow **location** when the browser asks. That is how the engine knows
   your speed.
3. Tap **Start**. You'll hear the starter, the catch and a cold-start flare.
4. Pair your phone (optional, recommended):
   1. Point the phone's camera at the QR code on the car's screen and open
      the link.
   2. Tap **Connect**. On iPhone, tap **Allow** when it asks for motion
      access. Android starts by itself.
   3. Lay the phone in the **Tesla phone dock** (the angled wireless-charging
      tray, about 45°), any way round, and keep the page open with the screen
      on. It charges while it streams. A dash or vent holder works too.
5. Drive. The phone calibrates itself in the first few seconds of driving
   (see *How the phone is understood*).

No camera? Open `yourdomain.com/phone.html` on the phone and type the
six-character code shown under the QR code. The phone remembers the code, so
next time just open the page again. The car keeps its code between visits
too; use **Settings › New code** if you want a fresh one.

While stopped, hold **Hold to rev** to rev the engine in neutral: the revs
climb smoothly, like a foot pressing down, and reach the limiter after about
four seconds. Let go and they drop back to idle. With the other sounds the
same button spools the jet to takeoff thrust, sends the freighter to
hyperspace or makes the horse rear up (see *The sounds*).

Pick the sound in **Settings › Sound**.

Once a phone is paired (or you chose to drive without one), the right side
shows the **G-meter**: a live dot for the current acceleration, braking and
cornering force, and an outline of the highest G reached in each direction,
with the maximum acceleration, braking, left and right values underneath.
The maxima are kept between visits; **Reset max G** clears them.

Sound plays at full volume; turn it up or down with the car's own volume
control.

### Permissions

| Device | What it asks | If you said no |
| --- | --- | --- |
| Tesla browser | Location | Allow location for the site in the browser's site settings, then reload. |
| iPhone (Safari) | Motion & orientation, after tapping Connect | Close the tab, scan the QR again and tap Allow. |
| Android (Chrome) | Nothing, usually | Chrome › site settings › Motion sensors › Allow. |

Both sensors only work on **https://** pages, which is why the site must be
published with SSL.

### Settings

- **Sound**: one of the six sounds below. The artwork, the dial and the
  readouts change with it. Switching while the engine runs restarts it as
  the new one.
- **Drive mode**:
  - *Comfort*: early upshifts and a quieter exhaust.
  - *Sport*: holds gears, blips on downshifts, crackles when you lift.
  - *Track*: revs to the limit, aggressive downshifts.

  The other sounds use it too: how fast the jet spools, how eagerly the
  freighter answers, whether the coachman uses the whip.
- **Pops and bangs**: Off, Mild or Wild (engines only).
- **Speed**: km/h or mph.
- **Simulator**: on-screen throttle and brake pedals, also on the keyboard
  (↑ / ↓, hold Shift for half). The simulated car behaves like a Tesla, with
  instant torque and one-pedal regen. Try everything without a car or a phone.
- **Pairing code**: shows the code and lets you make a new one.

## The sounds

![The six sounds, each with its own neon artwork](docs/screenshot-sounds.png)

| Sound | What you hear | The dial | Hold the button (standing still) |
| --- | --- | --- | --- |
| **Flat six** (default) | Porsche 911 GT3: 4.0 boxer to 9,000 rpm, 7-speed PDK, blips, pops and bangs. | rpm | Revs in neutral to the limiter. |
| **Classic V8** | A 70s muscle car: lumpy, burbling V8 idle, lazy 3-speed automatic with a slipping torque converter, no rev limiter, it just runs out of breath at 5,800 rpm. | rpm | Revs in neutral. |
| **Superbike** | 1000 cc inline-four screaming to 14,000 rpm, 6-speed with quickshifter, autoblipper and crackle. | rpm | Revs in neutral. |
| **Jet engine** | CFM56-style turbofan: air-starter whine, light-off, slow spool from idle, fan whine and the takeoff buzz-saw and roar. Brake hard from speed and the thrust reversers deploy. Stopping winds the spools down for a long while. | N1 % | Spools to takeoff thrust. |
| **Space freighter** | Millennium Falcon-style sublight engines: throbbing, gritty roar and whine. Sometimes the hyperdrive won't catch at the first attempt. | power % | Hold for about three seconds at full power to **jump to hyperspace**. |
| **Horse carriage** | Clip-clop! Walk, trot, canter and gallop follow your speed, with iron tyres rumbling, wooden creaks, harness bells, the brake squealing when you stop hard, a whinny when you set off and a snort when you stop. Floor it and the coachman cracks the whip. | strides per minute | The horse paws the ground, then rears up and whinnies. |

![Settings: pick a sound](docs/screenshot-settings.png)

## Publish it

The site is the repository root: `index.html` (car), `phone.html` (phone),
`style.css`, `js/`, `assets/`. Any static host with HTTPS works.

### Hostinger, deployed from GitHub

1. In **hPanel › Websites › Manage › Advanced › GIT**, create a repository:
   - Repository: `https://github.com/arnaumas27/untesled.git`. For a private
     repository, add the SSH key Hostinger shows to GitHub as a deploy key
     and use `git@github.com:arnaumas27/untesled.git`.
   - Branch: the one you want to publish, for example `main`.
   - Directory: leave empty to deploy into `public_html`, which must be empty.
2. Click **Create**, then **Deploy**.
3. Optional, auto-deploy on every push: in the same GIT section open
   **Auto deployment**, copy the webhook URL, and add it in GitHub under
   **Settings › Webhooks › Add webhook**.
4. Turn on SSL in **hPanel › Security › SSL** (the free certificate is
   enough). The included `.htaccess` sends every visitor to `https://`; it
   also sets the right file types and makes updates show up immediately.
5. Open `https://yourdomain.com` in the Tesla browser.

### GitHub Pages (alternative)

**Settings › Pages › Deploy from a branch**, then pick the branch and
`/ (root)`. The site appears at `https://arnaumas27.github.io/untesled/`
with HTTPS already on. (The `.htaccess` file is simply ignored there.)

### On your computer

```bash
python3 -m http.server 8080
```

Then open <http://localhost:8080>. The engine, the simulator and every
setting work locally. Pairing a phone needs the published `https://` site,
because your phone can't reach your computer's `localhost`.

After the first visit, a small service worker (`sw.js`) lets the app open
even without a connection. It always tries the network first, so new deploys
appear straight away. The phone link itself still needs internet on both
devices.

## Configuration

Everything lives in `js/config.js`:

- **`brokers`**: the public MQTT-over-WebSocket relays (EMQX, HiveMQ,
  Mosquitto, Eclipse). Both pages connect to all of them in parallel, and
  pairing works as long as one is reachable from both the car and the phone.
  For full control, run your own broker (for example Mosquitto with
  WebSockets, or a free HiveMQ Cloud or EMQX Serverless instance) and put it
  first. Each entry can carry a `username` and `password`.
- **`phoneSendHz`**: motion messages per second (25 by default).
- To try a different broker without editing files, add
  `?broker=wss://host:port/path` to the car page URL; the QR code passes it on
  to the phone.

## The sound engine

`js/engine-worklet.js` runs in an AudioWorklet on its own audio thread. A
ScriptProcessor fallback runs the same code on browsers without worklets
(force it with `?noworklet`). It hosts one synth per sound and crossfades
when you switch. The engines share one synth, `js/synth-piston.js`, voiced
three ways (flat six, V8, inline-four); the others have their own files.

### The engines

For the flat six, per sample:

- **Crankshaft and firing order.** One 720° cycle, six firings in the boxer
  order 1-6-2-4-3-5, alternating left bank (1–3) and right bank (4–6). The
  fundamental is rpm ÷ 20 Hz (450 Hz at 9,000 rpm).
- **Exhaust pulses.** Each firing is a pressure pulse: a sharp blowdown peak,
  then a scavenging dip. Its strength follows the load, and its sharp
  "crack" grows with throttle. The blowdown lasts about 10 ms whatever the
  revs, so idle sounds like separate, lumpy beats and high rpm merges them
  into a wail. Every cylinder is a little different and every event jitters
  slightly, so no two cycles are identical.
- **Deep, GT3-style voicing.** The right bank's pulses reach the tailpipes a
  little later and weaker than the left bank's, as with unequal exhaust
  paths. That makes the boxer's 1.5 engine order carry the sound: a note an
  octave below the firing frequency, about 100 Hz at 4,000 rpm and 210 Hz at
  8,500 rpm. It survives mono playback, so the car's subwoofer reproduces it.
- **Pipes.** Each bank feeds its own long header, modelled as a resonant
  delay line with low resonances. Short tailpipe combs add the metallic
  edge.
- **Body resonances.** A fixed bank of resonances (body boom around 80 Hz,
  muffler, rasp) doesn't move with rpm. Different harmonics light up as the revs climb,
  as in a real car.
- **Intake howl.** Intake strokes ring through plenum and runner
  resonances, with air rush that grows with throttle (individual throttle
  bodies, GT3-style).
- **Extras.**
  - Valve-train ticks, a faint gear whine, sub-bass at the firing order and
    the 1.5 order.
  - The starter motor, plus a settling thump at shutdown.
  - Overrun burble with afterfire **pops and bangs**: random, louder right
    after you lift and at high revs, plus a "brap" on upshift cuts.
  - The rev limiter stutter.
- **Output.** Tone opens with load and revs, saturation adds grit at full
  throttle, and a bass shelf adds weight. A loudness curve keeps idle
  quieter than full throttle, and a limiter protects the speakers.

Every character setting lives in the `PISTON_VOICES` table at the top of
`js/synth-piston.js`: cylinders and firing order, bank lag and strength,
pulse length, pipe lengths, body resonances, intake, sub-bass, tone and
loudness. Change it there to make an engine deeper or brighter.

- **V8**: Ford's 1-5-4-2-6-3-7-8 firing order on a cross-plane crank, so each
  bank fires unevenly into its own pipe: the burble. A big cam makes the
  cylinders burn unevenly at idle (the lope). Long, muffled pipes and a
  4-barrel carb's intake.
- **Inline-four**: 1-2-4-3, 4-2-1 headers, short sharp pulses, a loud airbox
  howl and very short pipes, for a scream rather than a rumble.

### The jet, the freighter and the horse

- **Turbofan** (`js/synth-jet.js`): the fan's blade-passing tone (24 blades)
  and its harmonic, a moaning pair of tones while taxiing, the core
  compressor's whine following N2, the buzz-saw rasp once the fan tips go
  supersonic, and a broadband jet roar that gets louder and brighter with
  thrust. Start-up has the air starter's rising whine and a light-off whump;
  reverse thrust adds roar and rush.
- **Space freighter** (`js/synth-freighter.js`): detuned sawtooths through a
  resonant filter, pulsed like a breathing engine, a ring-modulated roar, a
  turbine whine and electric crackle, all rising with power. Power-up and
  power-down glides, a clunk when the reactor catches, the failed-hyperdrive
  sputter and the hyperspace jump (charge, boom, whoosh).
- **Horse carriage** (`js/synth-carriage.js`): every hoof strike excites a
  few hollow resonances (the clip-clop), a thud and sometimes the clink of a
  shoe, timed by the gait (walk four even beats, trot two diagonal pairs,
  canter three beats, gallop four quick ones) with a short street echo.
  Iron tyres rumble and clatter, the wheels knock once per turn, the wood
  creaks, harness bells ring with the stride. The whinny is a sawtooth with a
  quavering, falling pitch through horse-like formants; the snort is air
  through fluttering lips; the whip is a swish and a crack.

All the synths together use a few percent of one desktop CPU core.

## The virtual drivetrain

`js/vehicle.js` models the engines and their gearboxes. For the flat six, a
992 GT3-style PDK:

- Ratios 3.75 / 2.38 / 1.72 / 1.34 / 1.11 / 0.96 / 0.84, final drive 4.47,
  315/30 R21 rear tyres. 100 km/h in 7th is about 2,750 rpm; 1st runs to
  about 73 km/h.
- **Throttle** is estimated from the car's acceleration compared with what a
  Tesla can do at that speed, so flooring it sounds flat-out in any model.
  Lifting off (regen) means a closed throttle: overrun and crackle.
- A **shift map** for each mode, with hysteresis, kickdown, and gear holding
  for engine braking. Upshifts cut the ignition; downshifts blip the
  throttle. Clutch slip at launch, a 9,000 rpm limiter, cranking and a
  cold-start fast idle.
- The **V8** has a 3-speed automatic (2.46 / 1.46 / 1.00, 3.50 final drive):
  slow shifts without ignition cut, a torque converter that slips more the
  harder you push, and a long, lazy crank.
- The **superbike** has six gears (1st runs to about 145 km/h), a
  quickshifter (short ignition cuts on upshifts), an autoblipper and a
  14,000 rpm limiter.

`js/powertrains.js` models the rest: the turbofan's N1 and N2 spools (with
lag, slower from idle) and its thrust reversers, the freighter's power level
and hyperspace jump, and the horse's gait chosen from your speed (with
hysteresis), the whip, and its moods while standing.

## How the phone is understood

`js/fusion.js`:

- Gravity tells which plane is horizontal. **Which way is forward** is
  learned automatically by matching the phone's horizontal acceleration
  against the speed changes the GPS reports, using a small least-squares fit.
  It converges during the first few seconds of driving, in any orientation.
- **The Tesla phone dock needs no calibration to start.** The console tray
  rises towards the dashboard, so a phone lying in it (about 45°) always has
  its screen facing up and back, whether its top points forward or back, and
  even in landscape. Forward is then "behind the screen", flattened to
  horizontal, so the throttle is right from the first second. The car screen
  shows the detected position and angle, for example *Tesla dock, 45°*. The
  same logic covers upright dash and vent holders.
- A phone lying flat gives no such hint, so it isn't trusted until it has
  calibrated, and it can never throttle backwards.
- Picking the phone up is detected (it spins), and it recalibrates once it is
  put down again. iOS reports acceleration with the opposite sign to Android;
  the phone page checks the sign against its orientation and corrects it.
- Between GPS fixes, speed is integrated from the phone. GPS corrects it
  with lag compensation, and also corrects any slow bias in the phone.
- If the phone drops out, everything falls back to GPS within half a second.
  If GPS goes quiet while standing still, which browsers often do, that
  counts as standing still, not as lost.

## Project files

| File | What it does |
| --- | --- |
| `index.html` | Car screen: dial, start button, artwork, pairing and simulator. |
| `phone.html` | Phone screen: pairing and motion streaming. |
| `style.css` | Styles for both pages. |
| `js/app.js` | Car page: wires sensors, fusion, vehicle, audio, link and UI together. |
| `js/ui.js` | Car screen rendering (dial, readouts, animated artwork, G-meter with saved maxima, panels, settings). |
| `js/sounds.js` | The list of sounds: names, dials, labels, which model and synth. |
| `js/vehicle.js` | Virtual piston engines and gearboxes (flat six, V8, superbike). |
| `js/powertrains.js` | Turbofan, space freighter and horse models. |
| `js/art.js` | Neon line artwork for each sound. |
| `js/fusion.js` | GPS + phone sensor fusion and automatic calibration. |
| `js/engine-worklet.js` | The AudioWorklet: hosts the synths and switches between them. |
| `js/synth-piston.js` | Engine synthesizer and its three voicings. |
| `js/synth-jet.js`, `js/synth-freighter.js`, `js/synth-carriage.js` | The other synthesizers. |
| `js/dsp.js` | Filters, resonators and oscillators shared by the synths. |
| `js/audio.js` | Web Audio graph, limiter, ScriptProcessor fallback. |
| `js/gps.js` | Geolocation tracking and speed. |
| `js/simulator.js` | Virtual pedals and a simple EV model. |
| `js/link.js` | Pairing protocol over MQTT: codes, discovery, failover, heartbeats. |
| `js/mqtt.js` | Minimal MQTT 3.1.1 client over WebSocket. |
| `js/qr.js` | QR code generator (SVG). |
| `js/phone.js` | Phone page logic. |
| `js/config.js` | Relays and rates. |
| `sw.js` | Offline support (network first). |
| `.htaccess` | HTTPS redirect, file types and caching for Hostinger. |
| `tests/` | Unit tests (`npm test`, Node 20+, no dependencies). |

## Development

```bash
npm test
```

This runs the tests for the drivetrain, sensor fusion and synth. Add
`?noworklet` to force the audio fallback, or `?broker=…` to use another
relay. In the browser console, `untesled` exposes the live objects, for
example `untesled.vehicle.rpm`.

What has been verified so far:

- In headless Chromium:
  - pairing through the real QR code over https/wss;
  - phones emulated as Android, and as iPhone with its permission prompt and
    sign convention;
  - relay failover and phone takeover;
  - the simulator and both audio paths;
  - offline start.
- Offline renders of the synth, checked for levels, spectrum and CPU.

It has not been tried in a real Tesla yet. If something behaves differently
there, the console object above is the place to look.

## Troubleshooting

- **No sound.**
  - Tap **Start**. Browsers only allow sound after a tap.
  - Check the car's media volume.
  - If the browser paused audio after you switched apps, tap the engine
    button once to resume.
- **"Location is blocked".** Allow location for the site in the Tesla
  browser, then reload.
- **The phone can't find the car.**
  - Check that both are online and the code on the phone matches the car.
  - Under the QR code, "Ready. Waiting for your phone…" means the car
    reached a relay.
  - If it says it can't reach the relay, the car has no internet, or all
    relays are blocked on that network.
- **The phone keeps dropping.**
  - The phone must stay on this page with the screen on. Low Power Mode and
    auto-lock stop it; the page asks for a wake lock where supported.
  - The car carries on with GPS meanwhile and picks the phone back up
    automatically.
- **The engine reacts late.** You're on GPS alone. Pair the phone.
- **"Another phone is connected".** The last phone to connect wins. Tap
  **Use this phone** to take over.

## Privacy and safety

- Nothing is recorded or uploaded except the live motion stream. It carries
  only acceleration plus the engine's rpm, gear and speed, never location.
  It passes through public relays, under a topic named after your pairing
  code; for privacy, use your own broker (see *Configuration*).
- Set the phone up before driving, and never handle it while driving.
- Keep the car's volume at a level where you can still hear what's around you,
  including emergency vehicles. Synthetic engine sound may be restricted in
  some places; check your local rules.

## Credits

- Fonts: [Michroma](https://fonts.google.com/specimen/Michroma) and
  [Barlow Semi Condensed](https://fonts.google.com/specimen/Barlow+Semi+Condensed),
  both under the SIL Open Font License 1.1. They are served from
  `assets/fonts/`, with their licenses alongside.
- Untesled is a fan project. It is not affiliated with or endorsed by
  Porsche, Tesla, Ford, CFM International or Lucasfilm. Every sound is an
  original synthesis inspired by the real (or fictional) thing, not a
  recording, and the drawings are original.
