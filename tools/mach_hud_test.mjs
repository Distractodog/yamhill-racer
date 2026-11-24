import assert from 'node:assert/strict';
import { aircraftSpeed, MACH_MPS, setUnits } from '../game/src/units.js';

try {
  setUnits('metric');
  assert.deepEqual(aircraftSpeed(0), { value: 0, unit: 'km/h', inMach: false });
  assert.deepEqual(aircraftSpeed(342), { value: 1231, unit: 'km/h', inMach: false });
  assert.deepEqual(aircraftSpeed(MACH_MPS), { value: '1.00', unit: 'Mach', inMach: true });
  assert.deepEqual(aircraftSpeed(600), { value: '1.75', unit: 'Mach', inMach: true });
  assert.equal(aircraftSpeed(MACH_MPS * 0.99, true).unit, 'Mach', 'holds Mach above the exit threshold');
  assert.deepEqual(aircraftSpeed(MACH_MPS * 0.979, true), { value: 1209, unit: 'km/h', inMach: false });

  setUnits('imperial');
  assert.deepEqual(aircraftSpeed(342), { value: 765, unit: 'mph', inMach: false });
  assert.deepEqual(aircraftSpeed(MACH_MPS), { value: '1.00', unit: 'Mach', inMach: true });
  assert.deepEqual(aircraftSpeed(MACH_MPS * 0.97, true), { value: 744, unit: 'mph', inMach: false });
  console.log('PASS aircraft HUD Mach readout: boundary hysteresis and metric/imperial fallback');
} finally {
  setUnits('metric');
}
