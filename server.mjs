import http from 'node:http';
import { DatabaseSync, backup } from 'node:sqlite';
import { randomBytes, randomUUID, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDocument } from './document-schema.mjs';

const root=dirname(fileURLToPath(import.meta.url));
const dataDir=resolve(process.env.DATA_DIR||join(root,'data'));
mkdirSync(dataDir,{recursive:true,mode:0o700});
const db=new DatabaseSync(join(dataDir,'non-audit.sqlite'));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS users(
 id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,name TEXT NOT NULL,organization TEXT NOT NULL,
 position TEXT NOT NULL DEFAULT '',password_hash TEXT NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('admin','inspector')),
 status TEXT NOT NULL CHECK(status IN ('pending','active','suspended')),created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(
 token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),csrf TEXT NOT NULL,expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS reports(
 id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id),document TEXT NOT NULL,
 version INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'draft',visibility TEXT NOT NULL DEFAULT 'internal',
 created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS report_revisions(
 report_id TEXT NOT NULL REFERENCES reports(id),version INTEGER NOT NULL,document TEXT NOT NULL,
 actor_id TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,PRIMARY KEY(report_id,version));
CREATE TABLE IF NOT EXISTS idempotency(
 user_id TEXT NOT NULL REFERENCES users(id),key TEXT NOT NULL,body_hash TEXT NOT NULL,response TEXT NOT NULL,
 PRIMARY KEY(user_id,key));
CREATE TABLE IF NOT EXISTS audit_log(
 id INTEGER PRIMARY KEY,actor_id TEXT,event TEXT NOT NULL,target_id TEXT,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS rate_limits(key TEXT PRIMARY KEY,count INTEGER NOT NULL,expires_at INTEGER NOT NULL);
`);

const now=()=>new Date().toISOString();
const hash=value=>createHash('sha256').update(value).digest('hex');
const derive=promisify(scrypt);
let hashing=0;
async function passwordHash(password,salt=randomBytes(16).toString('hex')){
 if(hashing>=4)throw Object.assign(new Error('BUSY'),{status:429});
 hashing++;
 try{const value=await derive(password,salt,64,{N:32768,r:8,p:1,maxmem:64*1024*1024});return `scrypt:${salt}:${value.toString('hex')}`;}
 finally{hashing--;}
}
async function passwordValid(password,stored){
 const [,salt,value]=stored.split(':');const computed=(await passwordHash(password,salt)).split(':')[2];
 const a=Buffer.from(value,'hex'),b=Buffer.from(computed,'hex');return a.length===b.length&&timingSafeEqual(a,b);
}
function audit(actor,event,target){db.prepare('INSERT INTO audit_log(actor_id,event,target_id,created_at) VALUES(?,?,?,?)').run(actor,event,target,now());}
function transaction(fn){db.exec('BEGIN IMMEDIATE');try{const out=fn();db.exec('COMMIT');return out;}catch(e){db.exec('ROLLBACK');throw e;}}
function fail(status,code){throw Object.assign(new Error(code),{status,code});}
function text(value,min,max){return typeof value==='string'&&value.trim().length>=min&&value.length<=max;}
function validEmail(value){return text(value,3,254)&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);}
function limit(key,max,seconds){
 const current=Date.now();const row=db.prepare('SELECT * FROM rate_limits WHERE key=?').get(key);
 if(!row||row.expires_at<=current)db.prepare('INSERT OR REPLACE INTO rate_limits VALUES(?,?,?)').run(key,1,current+seconds*1000);
 else{if(row.count>=max)fail(429,'RATE_LIMIT');db.prepare('UPDATE rate_limits SET count=count+1 WHERE key=?').run(key);}
}
function json(res,status,value){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));}
function cookie(req){const items=(req.headers.cookie||'').split(';');const found=items.find(s=>s.trim().startsWith('sao_session='));return found?found.trim().slice(12):'';}
function sessionFor(req){
 const token=cookie(req);if(!/^[a-f0-9]{64}$/.test(token))return null;
 return db.prepare(`SELECT s.token_hash,s.csrf,s.expires_at,u.* FROM sessions s JOIN users u ON u.id=s.user_id
 WHERE s.token_hash=? AND s.expires_at>? AND u.status='active'`).get(hash(token),Date.now())||null;
}
function requireSession(req){const s=sessionFor(req);if(!s)fail(401,'NOT_AUTHENTICATED');return s;}
function csrf(req,s){const supplied=req.headers['x-csrf-token'];if(typeof supplied!=='string'||supplied!==s.csrf)fail(403,'CSRF_INVALID');}
async function body(req,max=40*1024*1024){
 if(!(req.headers['content-type']||'').startsWith('application/json'))fail(415,'JSON_REQUIRED');
 const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>max)fail(413,'PAYLOAD_TOO_LARGE');chunks.push(chunk);}
 try{return JSON.parse(Buffer.concat(chunks).toString());}catch{fail(400,'INVALID_JSON');}
}

async function createAdmin(){
 const email=(process.env.ADMIN_EMAIL||'').trim().toLowerCase(),password=process.env.ADMIN_PASSWORD||'',name=(process.env.ADMIN_NAME||'ผู้ดูแลระบบ').trim();
 if(!validEmail(email)||!text(password,12,128)||!text(name,2,120))throw Error('Set ADMIN_EMAIL, ADMIN_PASSWORD (12+ characters), ADMIN_NAME');
 if(db.prepare('SELECT id FROM users WHERE email=?').get(email))throw Error('Email already exists; no account was changed');
 const password_hash=await passwordHash(password),id=randomUUID();
 transaction(()=>{db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?,?,?)').run(id,email,name,'สำนักตรวจเงินแผ่นดินจังหวัดสุรินทร์','ผู้ดูแลระบบ',password_hash,'admin','active',now());audit(id,'admin_created',id);});
 console.log('Admin created. Password is not printed.');
}

async function serve(){
 const port=Number(process.env.PORT||3000),production=process.env.NODE_ENV==='production';
 const originValue=process.env.APP_ORIGIN||process.env.RENDER_EXTERNAL_URL||(!production?`http://localhost:${port}`:'');
 if(!originValue)throw Error('APP_ORIGIN is required');
 const originUrl=new URL(originValue);if(production&&originUrl.protocol!=='https:')throw Error('Production APP_ORIGIN must use HTTPS');
 if(originUrl.href!==originUrl.origin+'/')throw Error('APP_ORIGIN must contain only the origin');
 const origin=originUrl.origin;
 const cookieOptions=`; Path=/; HttpOnly; SameSite=Lax${production?'; Secure':''}`;
 const dummy=await passwordHash(randomBytes(32).toString('hex'));
 const publicRoot=join(root,'public');
 const protectedPages=new Set(['create-report.html','search-reports.html','archive-reports.html','tracking.html','help.html','ai-assistant.html','public-results.html','visitors-admin.html','knowledge-base.html','admin.html']);
 const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.jpeg':'image/jpeg','.jpg':'image/jpeg','.png':'image/png','.webp':'image/webp','.woff2':'font/woff2'};
 const server=http.createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  if(production)res.setHeader('Strict-Transport-Security','max-age=31536000');
  try{
   const url=new URL(req.url,origin),path=url.pathname;
   if(path.startsWith('/api/')){
    const ip=process.env.TRUST_PROXY==='1'?String(req.headers['x-forwarded-for']||req.socket.remoteAddress).split(',').at(-1).trim():req.socket.remoteAddress;
    if(!['GET','HEAD'].includes(req.method)&&req.headers.origin!==origin)fail(403,'ORIGIN_DENIED');
    if(path==='/api/health'&&req.method==='GET'){json(res,200,{success:true});return;}
    if(path==='/api/register'&&req.method==='POST'){
     limit('register:'+hash(ip),8,900);const b=await body(req,16384);const email=typeof b.email==='string'?b.email.trim().toLowerCase():'';
     if(!validEmail(email)||!text(b.fullName,2,120)||!text(b.organization,2,200)||!text(b.position||'',0,120)||!text(b.password,12,128)||b.acknowledged!==true)fail(400,'INVALID_FIELDS');
     const password_hash=await passwordHash(b.password),id=randomUUID();
     transaction(()=>{const out=db.prepare('INSERT OR IGNORE INTO users VALUES(?,?,?,?,?,?,?,?,?)').run(id,email,b.fullName.trim(),b.organization.trim(),(b.position||'').trim(),password_hash,'inspector','pending',now());if(out.changes)audit(id,'registered',id);});
     json(res,202,{success:true,status:'pending',emailVerificationRequired:false});return;
    }
    if(path==='/api/login'&&req.method==='POST'){
     limit('login:'+hash(ip),20,900);const b=await body(req,16384);const email=typeof b.email==='string'?b.email.trim().toLowerCase():'';
     if(!validEmail(email)||!text(b.password,1,128))fail(401,'INVALID_CREDENTIALS');
     limit('email:'+hash(email),12,900);const u=db.prepare('SELECT * FROM users WHERE email=?').get(email);
     const valid=await passwordValid(b.password,u?.password_hash||dummy);if(!u||!valid)fail(401,'INVALID_CREDENTIALS');
     if(u.status==='pending')fail(403,'ACCOUNT_PENDING');if(u.status!=='active')fail(403,'ACCOUNT_SUSPENDED');
     const token=randomBytes(32).toString('hex'),csrfToken=randomBytes(32).toString('hex');
     transaction(()=>{const previous=cookie(req);if(previous)db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(previous));db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(hash(token),u.id,csrfToken,Date.now()+8*3600000);audit(u.id,'login',u.id);});
     res.setHeader('Set-Cookie',`sao_session=${token}${cookieOptions}; Max-Age=28800`);
     json(res,200,{success:true,authenticated:true,accountStatus:'active'});return;
    }
    if(path==='/api/session'&&req.method==='GET'){
     const s=requireSession(req);json(res,200,{authenticated:true,accountStatus:'active',user:{id:s.id,displayName:s.name,role:s.role,permissions:['reports:create','reports:read',...(s.role==='admin'?['users:manage']:[])]},csrfToken:s.csrf});return;
    }
    const s=requireSession(req);if(!['GET','HEAD'].includes(req.method))csrf(req,s);
    if(path==='/api/logout'&&req.method==='POST'){db.prepare('DELETE FROM sessions WHERE token_hash=?').run(s.token_hash);res.setHeader('Set-Cookie',`sao_session=${cookieOptions}; Max-Age=0`);json(res,200,{success:true});return;}
    if(path==='/api/stats'&&req.method==='GET'){
     const r=db.prepare("SELECT count(*) AS total FROM reports WHERE owner_id=? OR ?='admin'").get(s.id,s.role);
     json(res,200,{totalReports:r.total,approvedReports:null,overdueItems:null,publishedReports:null});return;
    }
    if(path==='/api/admin/users'&&req.method==='GET'){
     if(s.role!=='admin')fail(403,'ADMIN_REQUIRED');json(res,200,{success:true,users:db.prepare('SELECT id,email,name,organization,role,status,created_at FROM users ORDER BY created_at DESC').all()});return;
    }
    if(path.startsWith('/api/admin/users/')&&req.method==='PATCH'){
     if(s.role!=='admin')fail(403,'ADMIN_REQUIRED');const id=decodeURIComponent(path.slice('/api/admin/users/'.length)),b=await body(req,4096);
     if(!['active','pending','suspended'].includes(b.status))fail(400,'INVALID_STATUS');
     transaction(()=>{const target=db.prepare('SELECT role FROM users WHERE id=?').get(id);if(!target)fail(404,'NOT_FOUND');if(target.role==='admin')fail(403,'ADMIN_ACCOUNT_PROTECTED');db.prepare('UPDATE users SET status=? WHERE id=?').run(b.status,id);db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);audit(s.id,'account_'+b.status,id);});json(res,200,{success:true});return;
    }
    if(path==='/api/reports'&&req.method==='GET'){
     const rows=db.prepare("SELECT id,json_extract(document,'$.parts.cover.title.text') AS title,version,status,updated_at FROM reports WHERE owner_id=? OR ?='admin' ORDER BY updated_at DESC").all(s.id,s.role);json(res,200,{success:true,reports:rows});return;
    }
    if(path==='/api/reports'&&req.method==='POST'){
     const b=await body(req);validateDocument(b.document);if(!text(b.document.parts.cover.title.text,1,250))fail(400,'TITLE_REQUIRED');const key=req.headers['idempotency-key'];if(typeof key!=='string'||!text(key,8,200))fail(400,'IDEMPOTENCY_REQUIRED');
     const bodyHash=hash(JSON.stringify(b));const out=transaction(()=>{
      const previous=db.prepare('SELECT * FROM idempotency WHERE user_id=? AND key=?').get(s.id,key);if(previous){if(previous.body_hash!==bodyHash)fail(409,'IDEMPOTENCY_CONFLICT');return JSON.parse(previous.response);}
      const id=randomUUID(),date=now(),document=JSON.stringify(b.document);
      db.prepare('INSERT INTO reports VALUES(?,?,?,?,?,?,?,?)').run(id,s.id,document,1,'draft','internal',date,date);
      db.prepare('INSERT INTO report_revisions VALUES(?,?,?,?,?)').run(id,1,document,s.id,date);audit(s.id,'report_created',id);
      const result={success:true,report:{id,version:1}};db.prepare('INSERT INTO idempotency VALUES(?,?,?,?)').run(s.id,key,bodyHash,JSON.stringify(result));return result;
     });json(res,201,out);return;
    }
    if(path.startsWith('/api/reports/')&&['GET','PUT'].includes(req.method)){
     const id=decodeURIComponent(path.slice('/api/reports/'.length));
     if(req.method==='GET'){const row=db.prepare("SELECT * FROM reports WHERE id=? AND (owner_id=? OR ?='admin')").get(id,s.id,s.role);if(!row)fail(404,'NOT_FOUND');json(res,200,{success:true,report:{id:row.id,version:row.version,document:JSON.parse(row.document)}});return;}
     const b=await body(req);validateDocument(b.document);if(!text(b.document.parts.cover.title.text,1,250))fail(400,'TITLE_REQUIRED');if(!Number.isInteger(b.version))fail(400,'VERSION_REQUIRED');
     const out=transaction(()=>{const row=db.prepare("SELECT * FROM reports WHERE id=? AND (owner_id=? OR ?='admin')").get(id,s.id,s.role);if(!row)fail(404,'NOT_FOUND');if(row.version!==b.version)fail(409,'VERSION_CONFLICT');const v=row.version+1,document=JSON.stringify(b.document),date=now();db.prepare('UPDATE reports SET document=?,version=?,updated_at=? WHERE id=?').run(document,v,date,id);db.prepare('INSERT INTO report_revisions VALUES(?,?,?,?,?)').run(id,v,document,s.id,date);audit(s.id,'report_updated',id);return {success:true,report:{id,version:v}};});json(res,200,out);return;
    }
    if(path==='/api/ai')fail(503,'AI_NOT_CONFIGURED');
    fail(404,'NOT_FOUND');
   }
   if(!['GET','HEAD'].includes(req.method))fail(405,'METHOD_NOT_ALLOWED');
   let relative=decodeURIComponent(path).replace(/^\/+/, '')||'index.html';if(relative==='create-report.html.html'){res.writeHead(302,{Location:'/create-report.html'});res.end();return;}
   if(relative==='visitors-admin.html'){res.writeHead(302,{Location:'/admin.html','Cache-Control':'no-store'});res.end();return;}
   if(protectedPages.has(relative)&&!sessionFor(req)){res.writeHead(302,{Location:'/login.html?next='+encodeURIComponent(relative),'Cache-Control':'no-store'});res.end();return;}
   const allowed=relative==='index.html'||relative==='login.html'||relative==='register.html'||protectedPages.has(relative)||/^assets\/[\w.-]+\.(png|jpeg|jpg|webp|woff2)$/.test(relative)||relative==='system.js';
   if(!allowed)fail(404,'NOT_FOUND');const file=resolve(publicRoot,relative);if(!file.startsWith(publicRoot+'/')||!existsSync(file))fail(404,'NOT_FOUND');
   res.writeHead(200,{'Content-Type':mime[extname(file)]||'application/octet-stream','Cache-Control':'no-store'});res.end(req.method==='HEAD'?undefined:readFileSync(file));
  }catch(e){if(!res.headersSent)json(res,e.status||400,{success:false,code:e.code||(e.message==='INVALID_DOCUMENT'?'INVALID_DOCUMENT':'REQUEST_FAILED')});else res.end();}
 });
 server.requestTimeout=30000;server.headersTimeout=15000;
 server.listen(port,'0.0.0.0',()=>console.log(`Non-Audit server listening on port ${port}`));
 const clean=setInterval(()=>{db.prepare('DELETE FROM sessions WHERE expires_at<?').run(Date.now());db.prepare('DELETE FROM rate_limits WHERE expires_at<?').run(Date.now());},60000);clean.unref();
 process.on('SIGTERM',()=>server.close(()=>{db.close();process.exit(0);}));
}

try{
 if(process.argv[2]==='create-admin'){await createAdmin();db.close();}
 else if(process.argv[2]==='backup'){const path=join(dataDir,'backup-'+Date.now()+'.sqlite');await backup(db,path);console.log('Backup created:',path);db.close();}
 else await serve();
}catch(e){console.error(e.message);process.exit(1);}
