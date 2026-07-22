import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const publicDir = join(root, 'public');
const dbPath = process.env.DB_PATH || join(root, 'data', 'db.json');
const port = Number(process.env.PORT || 3000);
const sessions = new Map();

const emptyDb = () => ({ users: [], communities: [], memberships: [], events: [], attendance: [], notifications: [] });
async function loadDb() {
  if (!existsSync(dbPath)) await writeFile(dbPath, JSON.stringify(emptyDb(), null, 2));
  return JSON.parse(await readFile(dbPath, 'utf8'));
}
async function saveDb(db) { await writeFile(dbPath, JSON.stringify(db, null, 2)); }
const hash = value => createHash('sha256').update(value).digest('hex');
const publicUser = u => ({ id: u.id, firstName: u.firstName, lastName: u.lastName, email: u.email, reputationScore: u.reputationScore || 0, createdAt: u.createdAt });

function send(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}
async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}
function auth(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return sessions.get(token) || null;
}
function requireAuth(req) {
  const userId = auth(req);
  if (!userId) throw Object.assign(new Error('Authentication required'), { status: 401 });
  return userId;
}
function route(pathname, pattern) {
  const a = pathname.split('/').filter(Boolean), b = pattern.split('/').filter(Boolean);
  if (a.length !== b.length) return null;
  const params = {};
  for (let i=0;i<a.length;i++) {
    if (b[i].startsWith(':')) params[b[i].slice(1)] = decodeURIComponent(a[i]);
    else if (a[i] !== b[i]) return null;
  }
  return params;
}
function validateString(value, name, min=1) {
  if (typeof value !== 'string' || value.trim().length < min) throw Object.assign(new Error(`${name} is required`), { status: 400 });
  return value.trim();
}
async function api(req, res, url) {
  const db = await loadDb();
  const p = url.pathname;
  if (req.method === 'GET' && p === '/api/health') return send(res, 200, { status: 'ok', service: 'hangout-app', timestamp: new Date().toISOString() });

  if (req.method === 'POST' && p === '/api/auth/register') {
    const x = await body(req); const email = validateString(x.email, 'email').toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) throw Object.assign(new Error('A valid email is required'), { status: 400 });
    if (db.users.some(u => u.email === email)) throw Object.assign(new Error('Email already registered'), { status: 409 });
    const password = validateString(x.password, 'password', 8);
    const user = { id: randomUUID(), firstName: validateString(x.firstName, 'firstName', 2), lastName: validateString(x.lastName, 'lastName', 2), email, passwordHash: hash(password), reputationScore: 0, createdAt: new Date().toISOString() };
    db.users.push(user); db.notifications.push({ id: randomUUID(), userId: user.id, title: 'Welcome to HANGOUT', message: 'Create or join a community to get started.', isRead: false, createdAt: new Date().toISOString() }); await saveDb(db);
    const token = randomUUID(); sessions.set(token, user.id); return send(res, 201, { accessToken: token, user: publicUser(user) });
  }
  if (req.method === 'POST' && p === '/api/auth/login') {
    const x = await body(req); const user = db.users.find(u => u.email === String(x.email || '').toLowerCase());
    const supplied = Buffer.from(hash(String(x.password || ''))); const stored = Buffer.from(user?.passwordHash || ''.padEnd(64, '0'));
    if (!user || supplied.length !== stored.length || !timingSafeEqual(supplied, stored)) throw Object.assign(new Error('Invalid email or password'), { status: 401 });
    const token = randomUUID(); sessions.set(token, user.id); return send(res, 200, { accessToken: token, user: publicUser(user) });
  }
  if (req.method === 'GET' && p === '/api/auth/me') {
    const id = requireAuth(req); return send(res, 200, publicUser(db.users.find(u => u.id === id)));
  }

  if (req.method === 'GET' && p === '/api/communities') {
    const q = String(url.searchParams.get('q') || '').toLowerCase();
    const items = db.communities.filter(c => !q || `${c.name} ${c.description}`.toLowerCase().includes(q)).sort((a,b)=>b.memberCount-a.memberCount);
    return send(res, 200, { items, total: items.length });
  }
  if (req.method === 'POST' && p === '/api/communities') {
    const userId = requireAuth(req), x = await body(req); const name = validateString(x.name, 'name', 3);
    if (db.communities.some(c => c.name.toLowerCase() === name.toLowerCase())) throw Object.assign(new Error('Community name already exists'), { status: 409 });
    const c = { id: randomUUID(), ownerId: userId, name, description: validateString(x.description, 'description', 10), isPublic: x.isPublic !== false, memberCount: 1, createdAt: new Date().toISOString() };
    db.communities.push(c); db.memberships.push({ id: randomUUID(), communityId: c.id, userId, role: 'OWNER' }); await saveDb(db); return send(res, 201, c);
  }
  let params = route(p, '/api/communities/:id/join');
  if (req.method === 'POST' && params) {
    const userId = requireAuth(req), c = db.communities.find(x => x.id === params.id); if (!c) throw Object.assign(new Error('Community not found'), { status: 404 });
    if (!db.memberships.some(m => m.communityId === c.id && m.userId === userId)) { db.memberships.push({ id: randomUUID(), communityId: c.id, userId, role: 'MEMBER' }); c.memberCount += 1; db.notifications.push({ id: randomUUID(), userId, title: 'Community joined', message: `You joined ${c.name}.`, isRead: false, createdAt: new Date().toISOString() }); await saveDb(db); }
    return send(res, 200, c);
  }

  if (req.method === 'GET' && p === '/api/events') {
    const items = db.events.filter(e => e.status === 'PUBLISHED').sort((a,b)=>new Date(a.eventDate)-new Date(b.eventDate)); return send(res, 200, { items, total: items.length });
  }
  if (req.method === 'POST' && p === '/api/events') {
    const hostId = requireAuth(req), x = await body(req); const eventDate = new Date(x.eventDate); if (Number.isNaN(eventDate.getTime())) throw Object.assign(new Error('Valid eventDate is required'), { status: 400 });
    const e = { id: randomUUID(), hostId, communityId: x.communityId || null, title: validateString(x.title, 'title', 3), description: validateString(x.description, 'description', 10), category: x.category || 'General', location: x.location || '', eventDate: eventDate.toISOString(), maxAttendees: Number(x.maxAttendees || 50), attendeeCount: 0, viewCount: 0, status: 'DRAFT', createdAt: new Date().toISOString() };
    db.events.push(e); await saveDb(db); return send(res, 201, e);
  }
  params = route(p, '/api/events/:id/publish');
  if (req.method === 'PATCH' && params) {
    const userId = requireAuth(req), e = db.events.find(x => x.id === params.id); if (!e) throw Object.assign(new Error('Event not found'), { status: 404 }); if (e.hostId !== userId) throw Object.assign(new Error('Only the host can publish this event'), { status: 403 }); e.status='PUBLISHED'; await saveDb(db); return send(res, 200, e);
  }
  params = route(p, '/api/events/:id/attend');
  if (req.method === 'POST' && params) {
    const userId = requireAuth(req), e = db.events.find(x => x.id === params.id && x.status === 'PUBLISHED'); if (!e) throw Object.assign(new Error('Published event not found'), { status: 404 });
    if (!db.attendance.some(a => a.eventId===e.id && a.userId===userId)) { if (e.maxAttendees && e.attendeeCount >= e.maxAttendees) throw Object.assign(new Error('Event is full'), { status: 409 }); db.attendance.push({ id: randomUUID(), eventId:e.id, userId, checkedIn:false, createdAt:new Date().toISOString() }); e.attendeeCount += 1; db.notifications.push({ id: randomUUID(), userId, title:'Attendance confirmed', message:`You are attending ${e.title}.`, isRead:false, createdAt:new Date().toISOString() }); await saveDb(db); }
    return send(res, 200, e);
  }
  params = route(p, '/api/events/:id');
  if (req.method === 'GET' && params) {
    const e = db.events.find(x=>x.id===params.id); if (!e) throw Object.assign(new Error('Event not found'), { status:404 }); e.viewCount += 1; await saveDb(db); return send(res,200,e);
  }

  if (req.method === 'GET' && p === '/api/search') {
    const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
    const events = db.events.filter(e=>e.status==='PUBLISHED' && `${e.title} ${e.description} ${e.category} ${e.location}`.toLowerCase().includes(q));
    const communities = db.communities.filter(c=>`${c.name} ${c.description}`.toLowerCase().includes(q));
    return send(res,200,{events,communities,total:events.length+communities.length});
  }
  if (req.method === 'GET' && p === '/api/notifications') {
    const userId=requireAuth(req); const items=db.notifications.filter(n=>n.userId===userId).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)); return send(res,200,{items,total:items.length,unread:items.filter(x=>!x.isRead).length});
  }
  return send(res, 404, { message: 'Route not found' });
}

const mime = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.svg':'image/svg+xml' };
async function staticFile(req,res,url) {
  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  const path = normalize(join(publicDir, requested));
  if (!path.startsWith(publicDir)) return send(res,403,{message:'Forbidden'});
  try { const data=await readFile(path); res.writeHead(200,{'content-type':mime[extname(path)]||'application/octet-stream'}); res.end(data); }
  catch { const data=await readFile(join(publicDir,'index.html')); res.writeHead(200,{'content-type':'text/html; charset=utf-8'}); res.end(data); }
}

export const server = http.createServer(async (req,res)=>{
  const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);
  try { if(url.pathname.startsWith('/api/')) await api(req,res,url); else await staticFile(req,res,url); }
  catch(error) { send(res,error.status||500,{message:error.status?error.message:'Internal server error'}); }
});
if (process.env.NODE_ENV !== 'test') server.listen(port,()=>console.log(`HANGOUT running at http://localhost:${port}`));
