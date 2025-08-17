const API = location.origin + '/api';
const $ = (s, r=document)=> r.querySelector(s);
const $$ = (s, r=document)=> Array.from(r.querySelectorAll(s));

let token = localStorage.getItem('token') || null;
let payload = token ? JSON.parse(atob(token.split('.')[1])) : null;

const screens = {
  auth: $('#screen-auth'),
  upload: $('#screen-upload'),
  analytics: $('#screen-analytics'),
  surveys: $('#screen-surveys'),
  admin: $('#screen-admin')
};

function goto(name){
  Object.values(screens).forEach(sc=> sc.classList.remove('active'));
  screens[name].classList.add('active');
}

/* Theme */
$('#themeToggle').addEventListener('click', ()=> document.body.classList.toggle('light'));

/* Logout */
$('#logoutBtn').addEventListener('click', ()=>{
  token = null; localStorage.removeItem('token'); payload=null;
  location.reload();
});

/* Auth tabs */
const tabs = $$('.tabs button');
const consentRow = $('#consentRow');
tabs.forEach(b=> b.addEventListener('click', ()=>{
  tabs.forEach(x=>x.classList.remove('active'));
  b.classList.add('active');
  consentRow.style.display = b.dataset.tab === 'signup' ? 'flex' : 'none';
}));

/* Auth submit */
$('#form-auth').addEventListener('submit', async (e)=>{
  e.preventDefault();
  const email = $('#email').value.trim();
  const password = $('#password').value;
  const isSignup = $$('.tabs button').find(x=>x.classList.contains('active')).dataset.tab === 'signup';

  try {
    const res = await fetch(API + (isSignup ? '/auth/signup' : '/auth/signin'), {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        email, password,
        acceptConsent: isSignup ? $('#consent').checked : undefined
      })
    });
    const data = await res.json();
    if(!res.ok) throw new Error(data.error || 'Eroare');
    token = data.token; localStorage.setItem('token', token);
    payload = JSON.parse(atob(token.split('.')[1]));
    $('#authMsg').textContent = '';
    initAppAfterLogin();
  } catch(err){
    $('#authMsg').textContent = err.message;
  }
});

function initAppAfterLogin(){
  // dacă e admin, arată și ecranul admin
  if (payload?.role === 'admin') loadAdmin();
  goto('upload');
  setupCamera();
  loadSurveys();
}

/* Camera */
const video = $('#video'), canvas = $('#canvas');
let stream = null;
$('#startCam').addEventListener('click', async ()=>{
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio:false });
    video.srcObject = stream;
  } catch (e){
    alert('Nu pot porni camera: ' + e.message);
  }
});
$('#snap').addEventListener('click', ()=>{
  if(!video.videoWidth) return;
  canvas.width = video.videoWidth; canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0,0);
  canvas.toBlob(blob=>{
    const url = URL.createObjectURL(blob);
    $('#downloadShot').href = url;
    // setăm fișierul în input pentru upload
    const file = new File([blob],'snapshot.jpg',{type:'image/jpeg'});
    const dt = new DataTransfer();
    dt.items.add(file);
    $('#file').files = dt.files;
  }, 'image/jpeg', 0.92);
});

/* Upload & parse */
$('#uploadBtn').addEventListener('click', async ()=>{
  const fileInput = $('#file');
  if(!fileInput.files[0]) { $('#uploadMsg').textContent = 'Alege o imagine sau un PDF.'; return; }
  const fd = new FormData();
  fd.append('file', fileInput.files[0]);
  $('#uploadMsg').textContent = 'Se încarcă și analizează...';
  try {
    const res = await fetch(API + '/receipts/upload', {
      method:'POST',
      headers:{ Authorization:'Bearer ' + token },
      body: fd
    });
    const data = await res.json();
    if(!res.ok) throw new Error(data.error || 'Eroare upload');
    $('#uploadMsg').textContent = 'Gata!';
    // afișează rezultate
    $('#resStore').textContent = data.store_name || '(necunoscut)';
    $('#resTotal').textContent = data.total_amount != null ? data.total_amount.toFixed(2) + ' RON' : '-';
    $('#resDate').textContent = data.purchase_datetime ? new Date(data.purchase_datetime).toLocaleString() : '-';

    const tbody = $('#itemsTable tbody'); tbody.innerHTML = '';
    (data.items || []).forEach((it, i)=>{
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${i+1}</td><td>${it.product_name}</td><td>${it.qty||''}</td><td>${it.unit_price?.toFixed ? it.unit_price.toFixed(2) : ''}</td><td>${it.total_price?.toFixed ? it.total_price.toFixed(2) : ''}</td><td>${it.category||''}</td>`;
      tbody.appendChild(tr);
    });

  } catch(err){
    $('#uploadMsg').textContent = err.message;
  }
});

/* Trimite raport pe email (backend ascunde adresa) */
$('#sendReport').addEventListener('click', async ()=>{
  try{
    const res = await fetch(API + '/analytics/send-report', { method:'POST', headers:{ Authorization:'Bearer ' + token } });
    const data = await res.json();
    if(!res.ok) throw new Error(data.error || 'Eroare trimitere');
    alert('Raport trimis pe email!');
  }catch(e){ alert(e.message); }
});

/* Agregări personale */
$('#toAnalytics').addEventListener('click', async ()=>{
  await loadAnalytics();
  goto('analytics');
});
$('#backToUpload').addEventListener('click', ()=> goto('upload'));

async function loadAnalytics(){
  const res = await fetch(API + '/analytics/overview', { headers:{ Authorization:'Bearer ' + token } });
  const data = await res.json();
  const tbp = $('#byProduct tbody'); tbp.innerHTML = '';
  data.byProduct.forEach(p=>{
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${p.name}</td><td>${(p.qty||0).toFixed(2)}</td><td>${(p.sum||0).toFixed(2)} RON</td>`;
    tbp.appendChild(tr);
  });
  const tbs = $('#byStore tbody'); tbs.innerHTML = '';
  data.byStore.forEach(s=>{
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${s.store}</td><td>${s.receipts}</td><td>${(s.total||0).toFixed(2)} RON</td>`;
    tbs.appendChild(tr);
  });
}

/* Sondaje */
async function loadSurveys(){
  const wrap = $('#surveysWrap'); wrap.innerHTML = '';
  try {
    const res = await fetch(API + '/surveys/active', { headers:{ Authorization:'Bearer ' + token }});
    const surveys = await res.json();
    if (surveys.length){
      const title = document.createElement('h3'); title.textContent = 'Răspunde și poți primi o recompensă (în curând)';
      wrap.appendChild(title);
    }
    for (const s of surveys){
      const box = document.createElement('div'); box.className='survey';
      box.innerHTML = `<h4>${s.title}</h4><p>${s.description||''}</p>`;
      const form = document.createElement('form');
      form.className='qform';
      const answers = {};
      s.questions.forEach(q=>{
        const qdiv = document.createElement('div'); qdiv.className='q';
        qdiv.innerHTML = `<b>${q.question}</b>`;
        if(q.kind==='text'){
          const ta = document.createElement('textarea');
          ta.oninput = ()=> answers[q.id] = ta.value;
          qdiv.appendChild(ta);
        } else if(q.kind==='single'){
          (q.options||[]).forEach(op=>{
            const lab = document.createElement('label');
            const inp = document.createElement('input'); inp.type='radio'; inp.name=q.id; inp.value=op;
            inp.onchange = ()=> answers[q.id] = op;
            lab.appendChild(inp); lab.append(' '+op);
            qdiv.appendChild(lab);
          });
        } else if(q.kind==='multi'){
          (q.options||[]).forEach(op=>{
            const lab = document.createElement('label');
            const inp = document.createElement('input'); inp.type='checkbox'; inp.value=op;
            inp.onchange = ()=>{
              const arr = answers[q.id] || [];
              if(inp.checked) arr.push(op); else arr.splice(arr.indexOf(op),1);
              answers[q.id] = arr;
            };
            lab.appendChild(inp); lab.append(' '+op);
            qdiv.appendChild(lab);
          });
        }
        form.appendChild(qdiv);
      });
      const btn = document.createElement('button'); btn.className='primary'; btn.textContent='Trimite răspunsurile';
      btn.type='submit'; form.appendChild(btn);
      form.addEventListener('submit', async (e)=>{
        e.preventDefault();
        const res = await fetch(API + `/surveys/${s.id}/answer`, { method:'POST', headers:{ 'Content-Type':'application/json', Authorization:'Bearer '+token }, body: JSON.stringify({ answers })});
        if (res.ok) alert('Mulțumim! Răspunsul a fost înregistrat.');
      });
      box.appendChild(form);
      wrap.appendChild(box);
    }
  } catch(e){
    console.warn('surveys load', e);
  }
}

/* Admin */
function loadAdmin(){
  (async()=>{
    const res = await fetch(API + '/admin/overview', { headers:{ Authorization:'Bearer '+token }});
    const data = await res.json();
    const el = $('#adminStats');
    el.innerHTML =
      `<p><b>Bonuri totale:</b> ${data.totals.receipts} &nbsp; <b>Coș mediu:</b> ${data.totals.avg_basket.toFixed(2)} RON</p>
       <h4>Top cafea</h4>
       <ul>${data.topCafe.map(c=>`<li>${c.name} — ${c.qty.toFixed(2)}</li>`).join('')}</ul>
       <h4>Top locații</h4>
       <ul>${data.byStore.map(s=>`<li>${s.store} — ${s.c} bonuri — ${s.total.toFixed(2)} RON</li>`).join('')}</ul>`;
    // Permite creare sondaj
    goto('admin');
  })();

  $('#addQ').onclick = ()=>{
    const row = document.createElement('div'); row.className='qrow';
    row.innerHTML = `
      <input class="qtext" placeholder="Întrebare" />
      <select class="qkind">
        <option value="single">Un singur răspuns</option>
        <option value="multi">Multiple</option>
        <option value="text">Text</option>
      </select>
      <textarea class="opts" placeholder="Opțiuni (separate prin virgulă)"></textarea>
    `;
    $('#svQs').appendChild(row);
  };

  $('#surveyForm').onsubmit = async (e)=>{
    e.preventDefault();
    const title = $('#svTitle').value.trim(), description = $('#svDesc').value.trim();
    const questions = $$('.qrow').map(r=>{
      const kind = $('.qkind', r).value;
      const question = $('.qtext', r).value;
      const options = $('.opts', r).value.split(',').map(s=>s.trim()).filter(Boolean);
      return { kind, question, options };
    });
    const res = await fetch(API + '/admin/surveys', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', Authorization:'Bearer '+token },
      body: JSON.stringify({ title, description, questions })
    });
    if(res.ok){ alert('Sondaj publicat'); $('#svQs').innerHTML=''; $('#svTitle').value=''; $('#svDesc').value=''; }
    else alert('Eroare publicare');
  };
}

/* Landing */
$('#year').textContent = new Date().getFullYear();

/* Autologin flow */
if (token) initAppAfterLogin();
else goto('auth');
