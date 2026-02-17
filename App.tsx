
import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';

// --- Constants & Types ---
enum AppState {
  IDLE = 'IDLE',
  DRAWING_LOT = 'DRAWING_LOT',
  SHOWING_LOT = 'SHOWING_LOT'
}

const MAX_PARTICLES_PER_EXPLOSION = 180;
const MAX_TOTAL_PARTICLES = 600;
const FIREWORK_DEBOUNCE = 400;
const INDEX_SWING_THRESHOLD = 0.08;
const GESTURE_EMA_ALPHA = 0.2;

const FORTUNES = [
  "大吉：万事如意",
  "上吉：紫气东来",
  "中吉：岁岁平安",
  "小吉：喜气洋洋",
  "大吉：龙行天下"
];

// --- Shaders ---
const FIREWORK_VS = `
  attribute float size;
  attribute float hue;
  attribute float life;
  varying float vHue;
  varying float vLife;
  void main() {
    vHue = hue;
    vLife = life;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    // Particle size flickers and fades
    float flicker = sin(life * 30.0) * 0.3 + 0.7;
    gl_PointSize = size * flicker * life;
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const FIREWORK_FS = `
  varying float vHue;
  varying float vLife;
  vec3 hsv2rgb(vec3 c) {
    vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
    vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
  }
  void main() {
    float r = distance(gl_PointCoord, vec2(0.5));
    if (r > 0.5) discard;
    vec3 color = hsv2rgb(vec3(vHue, 0.7, 1.0));
    // Soft glow effect
    float strength = pow(1.0 - r * 2.0, 1.5);
    gl_FragColor = vec4(color, vLife * strength);
  }
`;

// --- Helper Functions ---
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

const createFortuneTexture = (text: string) => {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 768;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#f4e4bc';
  ctx.fillRect(0, 0, 512, 768);
  ctx.strokeStyle = '#5d4037';
  ctx.lineWidth = 15;
  ctx.setLineDash([20, 10]);
  ctx.strokeRect(20, 20, 472, 728);
  ctx.fillStyle = '#3e2723';
  ctx.font = 'bold 64px "Songti SC", "SimSun", serif';
  ctx.textAlign = 'center';
  const chars = text.split('');
  const startY = 384 - (chars.length * 70) / 2 + 35;
  chars.forEach((char, i) => ctx.fillText(char, 256, startY + i * 75));
  ctx.strokeStyle = '#d32f2f';
  ctx.lineWidth = 4;
  ctx.setLineDash([]);
  ctx.strokeRect(380, 600, 80, 80);
  ctx.fillStyle = '#d32f2f';
  ctx.font = '32px serif';
  ctx.fillText('2026', 420, 650);
  return new THREE.CanvasTexture(canvas);
};

// --- Main App Component ---
const App: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<AppState>(AppState.IDLE);
  const [showHint, setShowHint] = useState(true);
  const [cameraError, setCameraError] = useState(false);

  // Three.js Refs
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.OrthographicCamera | null>(null);
  const particlesRef = useRef<THREE.Points | null>(null);
  const cardRef = useRef<THREE.Mesh | null>(null);
  const videoMeshRef = useRef<THREE.Mesh | null>(null);
  const trailMeshRef = useRef<THREE.Mesh | null>(null);

  // Logic Refs
  const lastFireworkTimeRef = useRef<number>(0);
  const lastIndexXRef = useRef<number[]>([]);
  const emaPalmOpenRef = useRef<number>(0);
  const subExplosionQueue = useRef<{x: number, y: number, time: number, hue: number}[]>([]);
  const drawStartTimeRef = useRef<number>(0);

  useEffect(() => {
    if (!containerRef.current) return;

    // --- 1. Scene Setup with Orthographic Camera ---
    const scene = new THREE.Scene();
    sceneRef.current = scene;

    const w = window.innerWidth;
    const h = window.innerHeight;
    const camera = new THREE.OrthographicCamera(-w/2, w/2, h/2, -h/2, -100, 1000);
    camera.position.z = 10;
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ 
      antialias: true, 
      alpha: true,
      preserveDrawingBuffer: true // Required for manual trail clearing
    });
    renderer.setSize(w, h);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.autoClear = false; // Disable auto clear for trail effect
    containerRef.current.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // --- 2. Background Video Layer ---
    const video = document.createElement('video');
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    const videoTexture = new THREE.VideoTexture(video);
    const videoGeo = new THREE.PlaneGeometry(w, h);
    const videoMat = new THREE.MeshBasicMaterial({ map: videoTexture, transparent: true, opacity: 0.3 });
    const videoMesh = new THREE.Mesh(videoGeo, videoMat);
    videoMesh.position.z = -5;
    scene.add(videoMesh);
    videoMeshRef.current = videoMesh;

    // --- 3. Trail Effect Layer ---
    const trailMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.1 });
    const trailMesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), trailMat);
    trailMesh.position.z = -1;
    scene.add(trailMesh);
    trailMeshRef.current = trailMesh;

    // --- 4. Particle System ---
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_TOTAL_PARTICLES * 3), 3));
    geometry.setAttribute('velocity', new THREE.BufferAttribute(new Float32Array(MAX_TOTAL_PARTICLES * 3), 3));
    geometry.setAttribute('life', new THREE.BufferAttribute(new Float32Array(MAX_TOTAL_PARTICLES), 1));
    geometry.setAttribute('size', new THREE.BufferAttribute(new Float32Array(MAX_TOTAL_PARTICLES), 1));
    geometry.setAttribute('hue', new THREE.BufferAttribute(new Float32Array(MAX_TOTAL_PARTICLES), 1));

    const material = new THREE.ShaderMaterial({
      vertexShader: FIREWORK_VS,
      fragmentShader: FIREWORK_FS,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    const particles = new THREE.Points(geometry, material);
    scene.add(particles);
    particlesRef.current = particles;

    // --- 5. Fortune Card ---
    const card = new THREE.Mesh(
      new THREE.PlaneGeometry(w * 0.4, w * 0.6),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0 })
    );
    card.visible = false;
    card.position.z = 50;
    scene.add(card);
    cardRef.current = card;

    // --- 6. Hand Tracking ---
    // @ts-ignore
    const hands = new Hands({
      locateFile: (file: string) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`
    });
    hands.setOptions({ maxNumHands: 1, modelComplexity: 1, minDetectionConfidence: 0.6, minTrackingConfidence: 0.5 });
    hands.onResults((results: any) => {
      if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
        handleGestures(results.multiHandLandmarks[0]);
      }
    });

    // @ts-ignore
    const mpCamera = new Camera(video, {
      onFrame: async () => await hands.send({ image: video }),
      width: 640,
      height: 480
    });
    mpCamera.start().catch(() => setCameraError(true));

    // --- 7. Animation Loop ---
    let frameId: number;
    const animate = (time: number) => {
      updateParticles();
      updateStates(time);
      checkSubExplosions(time);
      
      // Manual Render Order for Trails
      renderer.clear();
      renderer.render(scene, camera);
      frameId = requestAnimationFrame(animate);
    };
    frameId = requestAnimationFrame(animate);

    const handleResize = () => {
      const nw = window.innerWidth;
      const nh = window.innerHeight;
      renderer.setSize(nw, nh);
      camera.left = -nw / 2;
      camera.right = nw / 2;
      camera.top = nh / 2;
      camera.bottom = -nh / 2;
      camera.updateProjectionMatrix();
      videoMesh.geometry = new THREE.PlaneGeometry(nw, nh);
      trailMesh.geometry = new THREE.PlaneGeometry(nw, nh);
      card.geometry = new THREE.PlaneGeometry(nw * 0.4, nw * 0.6);
    };
    window.addEventListener('resize', handleResize);

    setTimeout(() => setShowHint(false), 3000);

    return () => {
      window.removeEventListener('resize', handleResize);
      cancelAnimationFrame(frameId);
      renderer.dispose();
      mpCamera.stop();
    };
  }, []);

  const triggerFirework = (x: number, y: number, isSub: boolean = false, overrideHue?: number) => {
    if (stateRef.current !== AppState.IDLE && !isSub) return;
    
    const now = performance.now();
    if (!isSub) {
      if (now - lastFireworkTimeRef.current < FIREWORK_DEBOUNCE) return;
      lastFireworkTimeRef.current = now;
      // Add sub-explosions to queue
      subExplosionQueue.current.push({ x, y, time: now + 150, hue: overrideHue || Math.random() });
    }

    const geo = particlesRef.current!.geometry;
    const pos = geo.attributes.position.array as Float32Array;
    const vel = geo.attributes.velocity.array as Float32Array;
    const life = geo.attributes.life.array as Float32Array;
    const sizeAttr = geo.attributes.size.array as Float32Array;
    const hueAttr = geo.attributes.hue.array as Float32Array;

    const hue = overrideHue !== undefined ? overrideHue : Math.random();
    const count = isSub ? 40 : 120;
    const baseSpeed = Math.min(window.innerWidth, window.innerHeight) * 0.015;
    const particleSize = Math.max(8, window.innerWidth * 0.02);

    let added = 0;
    for (let i = 0; i < MAX_TOTAL_PARTICLES && added < count; i++) {
      if (life[i] <= 0) {
        life[i] = 1.0;
        pos[i * 3] = x;
        pos[i * 3 + 1] = y;
        pos[i * 3 + 2] = 0;

        // Polar distribution
        const angle = Math.random() * Math.PI * 2;
        const speed = (Math.random() * 0.6 + 0.4) * (isSub ? baseSpeed * 0.6 : baseSpeed);
        vel[i * 3] = Math.cos(angle) * speed;
        vel[i * 3 + 1] = Math.sin(angle) * speed;
        vel[i * 3 + 2] = 0;

        sizeAttr[i] = isSub ? particleSize * 0.5 : particleSize;
        hueAttr[i] = (hue + (Math.random() - 0.5) * 0.05) % 1.0;
        added++;
      }
    }
    geo.attributes.position.needsUpdate = true;
    geo.attributes.life.needsUpdate = true;
    geo.attributes.size.needsUpdate = true;
    geo.attributes.hue.needsUpdate = true;
  };

  const checkSubExplosions = (time: number) => {
    const queue = subExplosionQueue.current;
    for (let i = queue.length - 1; i >= 0; i--) {
      if (time >= queue[i].time) {
        const parent = queue[i];
        // Trigger 3 sub explosions
        for (let j = 0; j < 3; j++) {
          const offX = (Math.random() - 0.5) * window.innerWidth * 0.1;
          const offY = (Math.random() - 0.5) * window.innerHeight * 0.1;
          triggerFirework(parent.x + offX, parent.y + offY, true, parent.hue);
        }
        queue.splice(i, 1);
      }
    }
  };

  const handleGestures = (landmarks: any) => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    
    // Mapping: landmark (0-1) to Screen Space (-w/2 to w/2)
    // Invert X because camera is usually mirrored
    const x = (1 - landmarks[9].x - 0.5) * w; 
    const y = -(landmarks[9].y - 0.5) * h;

    // Palm openness
    const wrist = landmarks[0];
    const tips = [8, 12, 16, 20];
    let avgDist = 0;
    tips.forEach(idx => {
      const tip = landmarks[idx];
      avgDist += Math.sqrt(Math.pow(tip.x - wrist.x, 2) + Math.pow(tip.y - wrist.y, 2));
    });
    avgDist /= tips.length;
    
    const isOpen = avgDist > 0.4;
    emaPalmOpenRef.current = emaPalmOpenRef.current * (1 - GESTURE_EMA_ALPHA) + (isOpen ? 1 : 0) * GESTURE_EMA_ALPHA;
    
    if (emaPalmOpenRef.current > 0.7) {
      triggerFirework(x, y);
    }

    // Index swing
    const indexTip = landmarks[8];
    const history = lastIndexXRef.current;
    history.push(indexTip.x);
    if (history.length > 5) history.shift();
    if (history.length === 5 && stateRef.current === AppState.IDLE) {
      const delta = history[4] - history[0];
      const prevDelta = history[3] - history[0];
      if (Math.abs(delta) > INDEX_SWING_THRESHOLD && Math.sign(delta) !== Math.sign(prevDelta)) {
         startDrawingLot();
      }
    }
  };

  const startDrawingLot = () => {
    stateRef.current = AppState.DRAWING_LOT;
    drawStartTimeRef.current = performance.now();
    const card = cardRef.current!;
    card.material.map = createFortuneTexture(FORTUNES[Math.floor(Math.random() * FORTUNES.length)]);
    card.material.opacity = 0;
    card.visible = true;
    card.scale.set(0.1, 0.1, 1);
    card.position.set((Math.random() - 0.5) * 100, (Math.random() - 0.5) * 100, 50);
  };

  const updateParticles = () => {
    if (!particlesRef.current) return;
    const geo = particlesRef.current.geometry;
    const pos = geo.attributes.position.array as Float32Array;
    const vel = geo.attributes.velocity.array as Float32Array;
    const life = geo.attributes.life.array as Float32Array;

    const gravity = Math.min(window.innerWidth, window.innerHeight) * 0.0003;

    for (let i = 0; i < MAX_TOTAL_PARTICLES; i++) {
      if (life[i] > 0) {
        pos[i * 3] += vel[i * 3];
        pos[i * 3 + 1] += vel[i * 3 + 1];
        
        vel[i * 3 + 1] -= gravity; // Subtle gravity
        vel[i * 3] *= 0.97;       // Friction
        vel[i * 3 + 1] *= 0.97;
        
        life[i] -= 0.012;
      }
    }
    geo.attributes.position.needsUpdate = true;
    geo.attributes.life.needsUpdate = true;
  };

  const updateStates = (time: number) => {
    if (stateRef.current === AppState.DRAWING_LOT) {
      const elapsed = time - drawStartTimeRef.current;
      const progress = Math.min(elapsed / 1200, 1);
      const ease = easeOutCubic(progress);
      const card = cardRef.current!;
      card.position.lerp(new THREE.Vector3(0, 0, 50), ease * 0.05);
      const s = 0.2 + 0.8 * ease;
      card.scale.set(s, s, 1);
      card.material.opacity = ease;
      if (progress >= 1) stateRef.current = AppState.SHOWING_LOT;
    }
  };

  const resetState = () => {
    if (stateRef.current === AppState.SHOWING_LOT) {
      stateRef.current = AppState.IDLE;
      cardRef.current!.visible = false;
    }
  };

  return (
    <div ref={containerRef} className="w-full h-full relative" onClick={resetState}>
      <div className="absolute top-10 left-0 w-full flex flex-col items-center pointer-events-none z-10">
        <h1 className="text-2xl font-black uppercase tracking-widest gradient-text">2026 Happy New Year</h1>
        <p className="text-white/40 text-[10px] mt-1 tracking-[0.2em]">PRECISION WEBGL AR EXPLOSION</p>
      </div>

      {showHint && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-20 animate-fade-in-out">
          <div className="bg-black/70 backdrop-blur-xl p-8 rounded-[2rem] border border-cyan-500/30 text-center shadow-2xl">
            <p className="text-cyan-400 text-xl font-bold mb-3">🖐 张开手掌 释放烟花</p>
            <p className="text-yellow-400 text-xl font-bold">☝ 食指晃动 抽取灵签</p>
          </div>
        </div>
      )}

      {cameraError && (
        <div className="absolute inset-0 bg-black/90 flex items-center justify-center z-50 p-12 text-center">
          <div>
            <p className="text-red-500 text-xl font-bold mb-6">Camera Permission Required</p>
            <button onClick={() => window.location.reload()} className="px-8 py-4 bg-cyan-600 text-white rounded-full font-bold shadow-lg shadow-cyan-500/50 active:scale-95 transition-transform">Retry Access</button>
          </div>
        </div>
      )}

      <div className="absolute bottom-8 left-0 w-full flex justify-center pointer-events-none z-10">
        <div className="px-6 py-3 rounded-full bg-black/30 backdrop-blur-md border border-white/10">
           <span className="text-white/50 text-[10px] font-medium tracking-[0.3em]">TAP SCREEN TO CLOSE FORTUNE</span>
        </div>
      </div>

      <style>{`
        @keyframes fade-in-out {
          0%, 100% { opacity: 0; transform: scale(0.9); }
          15%, 85% { opacity: 1; transform: scale(1); }
        }
        .animate-fade-in-out { animation: fade-in-out 3s ease-in-out forwards; }
      `}</style>
    </div>
  );
};

export default App;
