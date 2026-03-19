const MILO_API   = 'https://api-miloai.vercel.app/api/aijahat';
const MILO_TOKEN = 'MILO-AI-BLACKS3X';
const MAX_CTX    = 20;

function cors(res) {
  res.headers.set('Access-Control-Allow-Origin',  '*');
  res.headers.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.headers.set('Access-Control-Allow-Headers', 'Content-Type');
  return res;
}
function json(data, status = 200) {
  return cors(new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json' }
  }));
}

export async function onRequest({ request, env }) {
  const method = request.method;
  if (method === 'OPTIONS') return cors(new Response(null, { status: 200 }));

  const kv = env.CHAT_KV;
  if (!kv) return json({ ok: false, error: 'KV belum dikonfigurasi' }, 500);

  const url     = new URL(request.url);
  const session = (url.searchParams.get('session') || 'default').slice(0, 80);

  /* GET — ambil riwayat */
  if (method === 'GET') {
    try {
      const raw = await kv.get('chat:' + session);
      return json({ ok: true, session, history: raw ? JSON.parse(raw) : [] });
    } catch (e) { return json({ ok: false, error: e.message }, 500); }
  }

  /* POST — kirim pesan (+ opsional file content) */
  if (method === 'POST') {
    let body = {};
    try { body = await request.json(); } catch {}

    const message     = (body.message     || '').trim();
    const sessBody    = (body.session      || 'default').slice(0, 80);
    const fileContent = (body.fileContent  || '').slice(0, 8000); // max 8KB teks file
    const fileName    = (body.fileName     || '');

    if (!message && !fileContent) {
      return json({ ok: false, error: 'message atau file wajib ada' }, 400);
    }

    try {
      const raw   = await kv.get('chat:' + sessBody);
      let history = raw ? JSON.parse(raw) : [];

      // Bangun bagian file jika ada
      let fileBlock = '';
      if (fileContent) {
        fileBlock =
          '\n\n--- ISI FILE: ' + fileName + ' ---\n' +
          fileContent +
          '\n--- AKHIR FILE ---\n';
      }

      // Bangun prompt dengan riwayat + file
      let prompt = message + fileBlock;
      if (history.length > 0) {
        const ctx = history
          .slice(-(MAX_CTX * 2))
          .map(m => (m.role === 'user' ? 'User: ' + m.text : 'AI: ' + m.text))
          .join('\n');
        prompt =
          'Riwayat percakapan:\n' + ctx +
          '\n\nUser: ' + message + fileBlock +
          '\n\nLanjutkan percakapan dengan mengingat konteks di atas.';
      }

      // Panggil Milo-AI
      const miloRes = await fetch(
        MILO_API + '?text=' + encodeURIComponent(prompt) + '&token=' + MILO_TOKEN
      );
      if (!miloRes.ok) return json({ ok: false, error: 'Milo API error ' + miloRes.status }, 502);
      const miloJson = await miloRes.json();
      if (!miloJson.status || !miloJson.result) {
        return json({ ok: false, error: 'Milo API tidak mengembalikan hasil' }, 502);
      }

      const reply = miloJson.result;

      // Simpan ke riwayat — kalau ada file, simpan info filenya juga
      const userText = message + (fileName ? ' [📎 ' + fileName + ']' : '');
      history.push({ role: 'user', text: userText,       ts: Date.now() });
      history.push({ role: 'ai',   text: reply,           ts: Date.now() });

      // Kalau ada file, simpan juga ke sesi sebagai "memory" file
      if (fileContent) {
        let files = [];
        const rawFiles = await kv.get('files:' + sessBody);
        if (rawFiles) files = JSON.parse(rawFiles);
        files.push({ name: fileName, content: fileContent, ts: Date.now() });
        if (files.length > 10) files = files.slice(-10); // max 10 file per sesi
        await kv.put('files:' + sessBody, JSON.stringify(files), { expirationTtl: 2592000 });
      }

      if (history.length > MAX_CTX * 4) history = history.slice(-(MAX_CTX * 4));
      await kv.put('chat:' + sessBody, JSON.stringify(history), { expirationTtl: 2592000 });

      return json({ ok: true, reply, count: history.length });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  /* DELETE — hapus riwayat + file */
  if (method === 'DELETE') {
    try {
      await kv.delete('chat:' + session);
      await kv.delete('files:' + session);
      return json({ ok: true });
    } catch (e) { return json({ ok: false, error: e.message }, 500); }
  }

  return json({ ok: false, error: 'Method not allowed' }, 405);
}
