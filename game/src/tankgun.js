// Tank-only input and model animation. Angles are radians; positive pitch raises the gun.
export const isTank = v => v?.kind === 'car' && v.type === 'tank';
export const TURRET_RATE = 40 * Math.PI / 180, PITCH_MIN = -8 * Math.PI / 180, PITCH_MAX = 20 * Math.PI / 180;
export const tankDriveKey = (tank, code) => !tank || !code.startsWith('Arrow');
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const stick = x => Math.abs(x || 0) > .12 ? x : 0;

export function updateTankGun(v, dt, keys, pad, blocked) {
  if (!isTank(v)) return;
  const u = v.mesh.userData;
  if (!u.turret || !u.barrel) return;
  if (!blocked) {
    const traverse = clamp((keys.has('ArrowLeft') ? 1 : 0) - (keys.has('ArrowRight') ? 1 : 0) - stick(pad?.axes?.[2]), -1, 1);
    const elevate = clamp((keys.has('ArrowUp') ? 1 : 0) - (keys.has('ArrowDown') ? 1 : 0) - stick(pad?.axes?.[3]), -1, 1);
    const yaw = u.turret.rotation.y + traverse * TURRET_RATE * dt;
    u.turret.rotation.y = Math.atan2(Math.sin(yaw), Math.cos(yaw));
    u.barrel.rotation.x = -clamp(-u.barrel.rotation.x + elevate * TURRET_RATE * dt, PITCH_MIN, PITCH_MAX);
  }
  u.barrelRestZ ??= u.barrel.position.z;
  u.gunRecoil = Math.max(0, (u.gunRecoil || 0) - dt);
  u.barrel.position.z = u.barrelRestZ - .38 * u.gunRecoil / .22;
  // Only the moving subtree, after the hull has been posed by syncMesh.
  u.muzzle.updateWorldMatrix(true, false);
}

export function tankGunRay(mesh, origin, direction) {
  const muzzle = mesh.userData.muzzle;
  if (!muzzle) return false;
  origin.setFromMatrixPosition(muzzle.matrixWorld);
  direction.set(0, 0, 1).transformDirection(muzzle.matrixWorld);
  return true;
}
