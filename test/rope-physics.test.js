import test from 'node:test';
import assert from 'node:assert/strict';
import { RopePhysics } from '../public/rope-physics.js';
const make=(scale=1000)=>new RopePhysics({left:{x:0,y:scale*.02},right:{x:scale,y:scale*.02},scale});
const letter=scale=>({id:'letter',t:.5,mass:8,length:scale*.07});
const run=(rope,steps)=>{for(let i=0;i<steps;i++)rope.advance(1/120);};
const near=(a,b,tolerance=1e-7)=>assert.ok(Math.abs(a-b)<tolerance,`${a} != ${b}`);

test('gravity sags the cable and concentrated letter mass changes its equilibrium',()=>{
 const r=make();r.settle();const bare=r.sample(.5).y;
 assert.ok(bare>70);assert.ok(bare<160);
 r.setLoads([letter(1000)]);r.settle();assert.ok(r.sample(.5).y>bare+5);
 assert.deepEqual(r.points()[0],{x:0,y:20});assert.deepEqual(r.points().at(-1),{x:1000,y:20});
 const pts=r.points();for(let i=1;i<pts.length;i++)assert.ok(Math.hypot(pts[i].x-pts[i-1].x,pts[i].y-pts[i-1].y)<r.segmentLength*1000*1.05);
});

test('fixed steps produce the same trajectory at different render frame rates',()=>{
 const a=make(),b=make();for(const r of [a,b]){r.setLoads([letter(1000)]);r.settle();r.impulse(.5,{x:150,y:-40});}
 for(let i=0;i<60;i++)a.advance(1/60);for(let i=0;i<120;i++)b.advance(1/120);
 assert.deepEqual(a.points(),b.points());assert.deepEqual(a.sampleLoad('letter'),b.sampleLoad('letter'));
});

test('endpoint motion propagates and load removal releases cable tension',()=>{
 const r=make();r.setLoads([letter(1000)]);r.settle();const before=r.points();
 r.setAnchors({x:0,y:120},{x:1000,y:20});assert.equal(r.points()[0].y,120);assert.equal(r.points()[16].y,before[16].y);
 run(r,40);assert.ok(Math.abs(r.sample(.5).y-before[16].y)>5);assert.ok(Math.abs(r.sampleLoad('letter').angle)>.001);
 r.settle();r.setLoads([]);assert.equal(r.sampleLoad('letter'),null);assert.ok(r.activity()>0);
 run(r,60);assert.ok(r.points().every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)));
});

test('damping settles cable motion and envelope pendulum instead of swaying forever',()=>{
 const r=make();r.setLoads([letter(1000)]);r.settle();r.impulse(.5,{x:200,y:0});run(r,24);
 const initial=r.activity();assert.ok(initial>.001);assert.ok(Math.abs(r.sampleLoad('letter').angle)>.01);
 run(r,1440);assert.ok(r.activity()<initial*.01);assert.ok(Math.abs(r.sampleLoad('letter').angle)<.001);
});

test('long hidden-tab gaps are capped and resizing can reset without stale momentum',()=>{
 const a=make(),b=make();a.advance(3600);b.advance(.1);assert.deepEqual(a.points(),b.points());
 a.setAnchors({x:0,y:30},{x:640,y:90},{scale:640,snap:true});a.settle();
 assert.deepEqual(a.points()[0],{x:0,y:30});assert.deepEqual(a.points().at(-1),{x:640,y:90});assert.equal(a.activity(),0);
 a.advance(Infinity);a.advance(NaN);a.advance(-1);assert.ok(a.points().every(p=>Number.isFinite(p.y)));
});

test('width-normalized physics behaves identically at different resolutions',()=>{
 const a=make(1000),b=make(2000);a.setLoads([letter(1000)]);b.setLoads([letter(2000)]);a.settle();b.settle();
 a.impulse(.5,{x:100,y:-50});b.impulse(.5,{x:200,y:-100});run(a,80);run(b,80);
 a.points().forEach((p,i)=>{near(p.x*2,b.points()[i].x);near(p.y*2,b.points()[i].y);});
 near(a.sampleLoad('letter').angle,b.sampleLoad('letter').angle);
});

test('invalid solver inputs are rejected without unbounded allocation',()=>{
 assert.throws(()=>new RopePhysics({left:{x:0,y:0},right:{x:1,y:1},nodes:100000}));
 const r=make();assert.throws(()=>r.setAnchors({x:0,y:0},{x:0,y:0}));
 for(const load of [{id:'bad',t:-1,mass:8},{id:'bad',t:.5,mass:Infinity},{id:'bad',t:.5,mass:8,length:-1}])assert.throws(()=>r.setLoads([load]));
 assert.throws(()=>r.setLoads([letter(1000),letter(1000)]));assert.throws(()=>r.settle(100000));
});

test('repeated snapshots do not add impulses or change the simulated trajectory',()=>{
 const a=make(),b=make();const loads=[letter(1000),{id:'tag',t:.9,mass:4,length:40}];
 for(const r of [a,b]){r.setLoads(loads);r.settle();r.setAnchors({x:20,y:80},{x:940,y:30});}
 for(let i=0;i<240;i++){a.setLoads(loads);a.advance(1/120);b.advance(1/120);}
 assert.deepEqual(a.points(),b.points());assert.deepEqual(a.sampleLoad('letter'),b.sampleLoad('letter'));
});
