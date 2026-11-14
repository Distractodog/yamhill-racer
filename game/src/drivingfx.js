// Small fixed pools add gravel, scrape sparks, exhaust and wingtip vapour without touching physics.
import * as THREE from 'three';
const COUNT = 220, TRAILS = 80;
const SPARK = new THREE.Color('#ffb657'), GRAVEL = new THREE.Color('#ad9976'), EXHAUST = new THREE.Color('#a8adb1');
export class DrivingFX {
  constructor(scene) {
    this.scene = scene; this.cursor = 0; this.trailCursor = 0; this.clock = 0; this.tick = 0; this.trailTick = 0; this.hitCooldown = 0;
    this.pos = new Float32Array(COUNT * 3); this.vel = new Float32Array(COUNT * 3);
    this.colors = new Float32Array(COUNT * 3); this.life = new Float32Array(COUNT); this.maxLife = new Float32Array(COUNT);
    this.gravity = new Float32Array(COUNT); this.alpha = new Float32Array(COUNT); this.size = new Float32Array(COUNT);
    const g = new THREE.BufferGeometry();
    for (const [key, data, n] of [['position',this.pos,3],['color',this.colors,3],['alpha',this.alpha,1],['size',this.size,1]])
      g.setAttribute(key,new THREE.BufferAttribute(data,n).setUsage(THREE.DynamicDrawUsage));
    this.points = new THREE.Points(g,new THREE.ShaderMaterial({transparent:true,depthWrite:false,
      vertexShader:`attribute vec3 color; attribute float alpha; attribute float size; varying vec3 tint; varying float opacity;
      void main(){tint=color;opacity=alpha;vec4 p=modelViewMatrix*vec4(position,1.);gl_Position=projectionMatrix*p;gl_PointSize=alpha>0.?clamp(size*700./max(1.,-p.z),1.,24.):0.;}`,
      fragmentShader:`varying vec3 tint; varying float opacity; void main(){float r=length(gl_PointCoord-.5);if(r>.5||opacity<=0.)discard;gl_FragColor=vec4(tint,opacity*(1.-smoothstep(.2,.5,r)));}`
    }));this.points.frustumCulled=false;scene.add(this.points);
    this.trailPos=new Float32Array(TRAILS*6);this.trailA=new Float32Array(TRAILS*2);this.trailLife=new Float32Array(TRAILS);
    const tg=new THREE.BufferGeometry();tg.setAttribute('position',new THREE.BufferAttribute(this.trailPos,3).setUsage(THREE.DynamicDrawUsage));tg.setAttribute('alpha',new THREE.BufferAttribute(this.trailA,1).setUsage(THREE.DynamicDrawUsage));
    this.trails=new THREE.LineSegments(tg,new THREE.ShaderMaterial({transparent:true,depthWrite:false,
      vertexShader:'attribute float alpha; varying float a; void main(){a=alpha;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
      fragmentShader:'varying float a; void main(){gl_FragColor=vec4(.85,.92,1.,a);}'
    }));this.trails.frustumCulled=false;scene.add(this.trails);
    this.p=new THREE.Vector3();this.back=new THREE.Vector3();this.lastTips=[null,null];this.lastPos=new THREE.Vector3();this.kind=null;
  }
  emit(p, velocity, color, size, life, gravity, scatter=2) {
    const i=this.cursor++%COUNT,k=i*3;
    this.pos.set([p.x,p.y,p.z],k);this.vel.set([velocity.x*.15+(Math.random()-.5)*scatter,velocity.y*.15+Math.random()*scatter,velocity.z*.15+(Math.random()-.5)*scatter],k);
    color.toArray(this.colors,k);this.size[i]=size;this.maxLife[i]=this.life[i]=life;this.gravity[i]=gravity;
  }
  update(dt, car) {
    if (!Number.isFinite(dt) || dt <= 0) return;
    dt=Math.max(0,Math.min(.1,dt));this.clock+=dt;this.tick+=dt;this.trailTick+=dt;this.hitCooldown-=dt;
    const changed=this.kind!==car.kind || this.lastPos.distanceToSquared(car.renderPos)>250000;
    if(changed){this.lastTips=[null,null];this.trailLife.fill(0);this.life.fill(0);this.kind=car.kind;}
    this.lastPos.copy(car.renderPos);
    const speed=car.vel.length();
    if(car.hit>3 && this.hitCooldown<=0 && speed>3){
      this.p.copy(car.renderPos);this.p.y-=.3;
      for(let n=0;n<Math.min(18,Math.ceil(car.hit));n++)this.emit(this.p,car.vel,SPARK,.07,.25+Math.random()*.25,12,9);
      this.hitCooldown=.15;
    }
    if(this.tick>=.05){
      this.tick%=.05;
      for(const wheel of car.wheels||[])if(wheel.contact && [1,2,4].includes(wheel.surf) && speed>8){
        this.p.copy(wheel.contactPoint);this.p.y+=.1;this.emit(this.p,car.vel,GRAVEL,.045,.5,18,Math.min(7,speed*.1));
      }
      if(car.kind!=='jet' && speed>1 && (car.input?.throttle||0)>.15){
        this.p.set(car.kind==='bike'?.25:.55,.2,car.kind==='bike'?-1:-2).applyQuaternion(car.renderQuat).add(car.renderPos);
        this.back.set(0,.4,-2).applyQuaternion(car.renderQuat);this.emit(this.p,this.back,EXHAUST,.15,.7,-.3,.4);
      }
    }
    const flying=car.kind==='jet' && car.mode==='air' && speed>75;
    if(this.trailTick>=.035){
      this.trailTick%=.035;
      for(let side=0;side<2;side++){
        if(!flying){this.lastTips[side]=null;continue;}
        this.p.set(side?4.9:-4.9,.1,-.7).applyQuaternion(car.renderQuat).add(car.renderPos);
        const prev=this.lastTips[side];
        if(prev && prev.distanceToSquared(this.p)<10000){const i=this.trailCursor++%TRAILS;prev.toArray(this.trailPos,i*6);this.p.toArray(this.trailPos,i*6+3);this.trailLife[i]=1.35;}
        if(prev)prev.copy(this.p);else this.lastTips[side]=this.p.clone();
      }
    }
    for(let i=0;i<COUNT;i++){
      this.life[i]-=dt;this.alpha[i]=Math.max(0,this.life[i]/(this.maxLife[i]||1))*.65;
      if(this.life[i]<=0)continue;
      const k=i*3;this.vel[k+1]-=this.gravity[i]*dt;
      for(let a=0;a<3;a++)this.pos[k+a]+=this.vel[k+a]*dt;
      if(this.gravity[i]<0)this.size[i]+=dt*.3;
    }
    for(let i=0;i<TRAILS;i++){this.trailLife[i]-=dt;const a=Math.max(0,this.trailLife[i]/1.35)*.32;this.trailA[i*2]=this.trailA[i*2+1]=a;}
    for(const a of Object.values(this.points.geometry.attributes))a.needsUpdate=true;
    this.trails.geometry.attributes.position.needsUpdate=this.trails.geometry.attributes.alpha.needsUpdate=true;
  }
  dispose(){for(const mesh of [this.points,this.trails]){this.scene.remove(mesh);mesh.geometry.dispose();mesh.material.dispose();}}
}
