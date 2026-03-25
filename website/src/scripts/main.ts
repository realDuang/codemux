import '../styles/base.css';
import '../styles/utilities.css';
import '../styles/sections.css';
import { translations, type Lang } from './i18n';

// ===========================
// i18n System
// ===========================
const supportedLangs: Lang[] = ['en', 'zh'];

function isValidLang(value: string | null): value is Lang {
  return value !== null && supportedLangs.includes(value as Lang);
}

const storedLang = localStorage.getItem('codemux-lang');
let currentLang: Lang = isValidLang(storedLang) ? storedLang : 'en';

function applyLanguage(lang: Lang): void {
  currentLang = lang;
  localStorage.setItem('codemux-lang', lang);
  document.documentElement.lang = lang;

  const t = translations[lang];

  // Update all elements with data-i18n attribute
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n')!;
    if (t[key]) {
      el.innerHTML = t[key];
    }
  });

  // Update language switch buttons
  document.querySelectorAll<HTMLElement>('.lang-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.lang === lang);
  });

  // Restart typewriter with new text
  restartTypewriter(t['hero.subtitle']);
}

function initI18n(): void {
  document.querySelectorAll<HTMLElement>('.lang-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const lang = btn.dataset.lang;
      if (isValidLang(lang) && lang !== currentLang) {
        applyLanguage(lang);
      }
    });
  });

  // Apply initial language
  applyLanguage(currentLang);
}

// ===========================
// 1. Matrix Rain (Hero Canvas)
// ===========================
function initMatrixRain(): void {
  const canvas = document.getElementById('matrix-canvas') as HTMLCanvasElement;
  if (!canvas) return;
  const ctx = canvas.getContext('2d')!;
  let columns: number;
  let drops: number[];
  const chars: string[] = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789@#$%^&*()_+-=[]{}|;:<>?/~`'.split('');
  // Add katakana characters
  for (let i = 0x30A0; i <= 0x30FF; i++) chars.push(String.fromCharCode(i));

  function resize(): void {
    canvas.width = canvas.parentElement!.offsetWidth;
    canvas.height = canvas.parentElement!.offsetHeight;
    const fontSize = 14;
    columns = Math.floor(canvas.width / fontSize);
    drops = Array(columns).fill(1);
  }

  let isHeroVisible = true;
  const heroObs = new IntersectionObserver(entries => {
    isHeroVisible = entries[0].isIntersecting;
  }, { threshold: 0.1 });
  heroObs.observe(document.getElementById('hero')!);

  function draw(): void {
    if (!isHeroVisible) { requestAnimationFrame(draw); return; }
    ctx.fillStyle = 'rgba(10, 10, 15, 0.08)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.font = '14px JetBrains Mono, monospace';

    for (let i = 0; i < drops.length; i++) {
      if (i % 3 !== 0) continue; // Reduce density
      const char = chars[Math.floor(Math.random() * chars.length)];
      const x = i * 14;
      const y = drops[i] * 14;

      // Lead character is brighter
      if (Math.random() > 0.95) {
        ctx.fillStyle = '#5BC4F7';
      } else {
        ctx.fillStyle = 'rgba(0, 255, 136, 0.35)';
      }
      ctx.fillText(char, x, y);

      if (y > canvas.height && Math.random() > 0.975) {
        drops[i] = 0;
      }
      drops[i]++;
    }
    requestAnimationFrame(draw);
  }

  resize();
  window.addEventListener('resize', resize);
  draw();
}

// ===========================
// 2. Particle System (Features Canvas)
// ===========================
function initParticles(): void {
  const canvas = document.getElementById('particle-canvas') as HTMLCanvasElement;
  if (!canvas) return;
  const ctx = canvas.getContext('2d')!;
  interface Particle {
    x: number; y: number;
    vx: number; vy: number;
    size: number; opacity: number;
  }
  let particles: Particle[] = [];
  let mouseX = 0, mouseY = 0;
  const maxParticles = window.innerWidth < 768 ? 30 : 60;
  const connectionDist = 120;

  function resize(): void {
    const section = document.getElementById('features')!;
    canvas.width = section.offsetWidth;
    canvas.height = section.offsetHeight;
  }

  function createParticle(): Particle {
    return {
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      vx: (Math.random() - 0.5) * 0.3,
      vy: (Math.random() - 0.5) * 0.3,
      size: Math.random() * 2 + 0.5,
      opacity: Math.random() * 0.5 + 0.1
    };
  }

  function init(): void {
    resize();
    particles = [];
    for (let i = 0; i < maxParticles; i++) particles.push(createParticle());
  }

  let isFeaturesVisible = false;
  const featObs = new IntersectionObserver(entries => {
    isFeaturesVisible = entries[0].isIntersecting;
  }, { threshold: 0.05 });
  featObs.observe(document.getElementById('features')!);

  document.addEventListener('mousemove', (e: MouseEvent) => {
    const rect = canvas.getBoundingClientRect();
    mouseX = e.clientX - rect.left;
    mouseY = e.clientY - rect.top;
  });

  function draw(): void {
    if (!isFeaturesVisible) { requestAnimationFrame(draw); return; }
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    particles.forEach((p, i) => {
      // Mouse parallax (subtle)
      const dx = mouseX - p.x;
      const dy = mouseY - p.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 200) {
        p.x -= dx * 0.001;
        p.y -= dy * 0.001;
      }

      p.x += p.vx;
      p.y += p.vy;
      if (p.x < 0 || p.x > canvas.width) p.vx *= -1;
      if (p.y < 0 || p.y > canvas.height) p.vy *= -1;

      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(91, 196, 247, ${p.opacity})`;
      ctx.fill();

      // Connections
      for (let j = i + 1; j < particles.length; j++) {
        const p2 = particles[j];
        const d = Math.sqrt((p.x - p2.x) ** 2 + (p.y - p2.y) ** 2);
        if (d < connectionDist) {
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(p2.x, p2.y);
          ctx.strokeStyle = `rgba(91, 196, 247, ${0.08 * (1 - d / connectionDist)})`;
          ctx.lineWidth = 0.5;
          ctx.stroke();
        }
      }
    });
    requestAnimationFrame(draw);
  }

  init();
  window.addEventListener('resize', () => { resize(); });
  draw();
}

// ===========================
// 3. Typewriter Effect (Hero Subtitle)
// ===========================
let typewriterTimeout: ReturnType<typeof setTimeout> | null = null;

function restartTypewriter(text: string): void {
  const el = document.getElementById('hero-subtitle');
  if (!el) return;

  // Clear existing timeout
  if (typewriterTimeout !== null) {
    clearTimeout(typewriterTimeout);
    typewriterTimeout = null;
  }

  // Clear text, keep cursor
  const cursor = el.querySelector('.cursor') as HTMLElement;
  el.textContent = '';
  if (cursor) el.appendChild(cursor);

  let i = 0;
  function type(): void {
    if (i < text.length) {
      el.insertBefore(document.createTextNode(text.charAt(i)), cursor);
      i++;
      typewriterTimeout = setTimeout(type, 50 + Math.random() * 30);
    }
  }
  typewriterTimeout = setTimeout(type, 300);
}

function initTypewriter(): void {
  const t = translations[currentLang];
  restartTypewriter(t['hero.subtitle']);
}

// ===========================
// 4. Scroll Reveal (IntersectionObserver)
// ===========================
function initScrollReveal(): void {
  const revealElements = document.querySelectorAll('.reveal');
  const obs = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const target = entry.target as HTMLElement;
        const delay = target.style.transitionDelay || '0s';
        target.style.transitionDelay = delay;
        target.classList.add('visible');
      }
    });
  }, { threshold: 0.1, rootMargin: '0px 0px -50px 0px' });
  revealElements.forEach(el => obs.observe(el));
}

// ===========================
// 5. Navigation (Scroll & Mobile)
// ===========================
function initNav(): void {
  const nav = document.getElementById('nav');
  const toggle = document.getElementById('nav-toggle');
  const links = document.getElementById('nav-links');
  if (!nav || !toggle || !links) return;

  window.addEventListener('scroll', () => {
    nav.classList.toggle('scrolled', window.scrollY > 80);
  });

  toggle.addEventListener('click', () => {
    links.classList.toggle('open');
    const isOpen = links.classList.contains('open');
    toggle.textContent = isOpen ? '[ CLOSE ]' : '[ MENU ]';
    toggle.setAttribute('aria-expanded', String(isOpen));
  });

  links.querySelectorAll('a').forEach(a => {
    a.addEventListener('click', () => {
      links.classList.remove('open');
      toggle.textContent = '[ MENU ]';
      toggle.setAttribute('aria-expanded', 'false');
    });
  });
}

// ===========================
// 6. Terminal Tabs & Copy
// ===========================
function initTerminal(): void {
  const tabs = document.querySelectorAll<HTMLElement>('.terminal-tab');
  const contents = document.querySelectorAll<HTMLElement>('.terminal-content');
  const copyBtn = document.getElementById('copy-btn');
  if (!copyBtn) return;

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      contents.forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      const target = document.querySelector(`.terminal-content[data-content="${tab.dataset.tab}"]`);
      if (target) target.classList.add('active');
    });
  });

  copyBtn.addEventListener('click', () => {
    const active = document.querySelector('.terminal-content.active');
    if (!active) return;
    const commands: string[] = [];
    active.querySelectorAll('.command').forEach(cmd => commands.push(cmd.textContent || ''));
    navigator.clipboard.writeText(commands.join('\n')).then(() => {
      copyBtn.textContent = 'COPIED!';
      copyBtn.style.borderColor = 'var(--neon-green)';
      copyBtn.style.color = 'var(--neon-green)';
      setTimeout(() => {
        copyBtn.textContent = 'COPY';
        copyBtn.style.borderColor = '';
        copyBtn.style.color = '';
      }, 2000);
    });
  });
}

// ===========================
// 7. Engine Card 3D Tilt
// ===========================
function initCardTilt(): void {
  document.querySelectorAll<HTMLElement>('.engine-card').forEach(card => {
    card.addEventListener('mousemove', (e: MouseEvent) => {
      const rect = card.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const centerX = rect.width / 2;
      const centerY = rect.height / 2;
      const rotateX = ((y - centerY) / centerY) * -5;
      const rotateY = ((x - centerX) / centerX) * 5;
      card.style.transform = `perspective(800px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) translateY(-5px)`;

      // Animate border gradient angle
      const angle = Math.atan2(y - centerY, x - centerX) * (180 / Math.PI) + 180;
      card.style.setProperty('--card-angle', angle + 'deg');
    });
    card.addEventListener('mouseleave', () => {
      card.style.transform = '';
      card.style.setProperty('--card-angle', '0deg');
    });
  });
}

// ===========================
// 8. Network Graph (SVG Lines)
// ===========================
function initNetworkGraph(): void {
  function drawConnections(): void {
    const container = document.getElementById('network-graph');
    const svg = document.getElementById('connection-svg');
    if (!container || !svg) return;

    const hubNode = container.querySelector('.hub-node');
    const platformNodes = container.querySelectorAll('.platform-node');
    if (!hubNode) return;
    const containerRect = container.getBoundingClientRect();

    // Clear old lines
    svg.innerHTML = '';

    const hubRect = hubNode.getBoundingClientRect();
    const hubX = hubRect.left + hubRect.width / 2 - containerRect.left;
    const hubY = hubRect.top + hubRect.height / 2 - containerRect.top;

    platformNodes.forEach(node => {
      const nodeRect = node.getBoundingClientRect();
      const nodeX = nodeRect.left + nodeRect.width / 2 - containerRect.left;
      const nodeY = nodeRect.top + nodeRect.height / 2 - containerRect.top;

      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', String(hubX));
      line.setAttribute('y1', String(hubY));
      line.setAttribute('x2', String(nodeX));
      line.setAttribute('y2', String(nodeY));
      svg.appendChild(line);
    });
  }

  // Draw after layout settles
  setTimeout(drawConnections, 500);
  window.addEventListener('resize', () => setTimeout(drawConnections, 100));

  // Redraw when the section becomes visible
  const obs = new IntersectionObserver(entries => {
    if (entries[0].isIntersecting) setTimeout(drawConnections, 200);
  }, { threshold: 0.1 });
  const accessSection = document.getElementById('access');
  if (accessSection) obs.observe(accessSection);
}

// ===========================
// 9. Random Glitch Re-trigger
// ===========================
function initGlitchRetrigger(): void {
  const glitch = document.querySelector('.glitch') as HTMLElement;
  if (!glitch) return;

  function triggerGlitch(): void {
    glitch.style.animation = 'none';
    glitch.offsetHeight; // Force reflow
    glitch.style.animation = '';

    // Random strong glitch
    glitch.style.textShadow = `
      ${Math.random() * 6 - 3}px ${Math.random() * 4 - 2}px 0 rgba(91,196,247,0.7),
      ${Math.random() * -6 + 3}px ${Math.random() * 4 - 2}px 0 rgba(255,0,170,0.7)
    `;
    setTimeout(() => {
      glitch.style.textShadow = '0 0 20px rgba(91,196,247,0.5), 0 0 60px rgba(91,196,247,0.2)';
    }, 150);

    setTimeout(triggerGlitch, 4000 + Math.random() * 4000);
  }
  setTimeout(triggerGlitch, 3000);
}

// ===========================
// Initialize Everything
// ===========================
document.addEventListener('DOMContentLoaded', () => {
  initMatrixRain();
  initParticles();
  initScrollReveal();
  initNav();
  initTerminal();
  initCardTilt();
  initNetworkGraph();
  initGlitchRetrigger();
  initI18n(); // This also calls initTypewriter via applyLanguage
});
