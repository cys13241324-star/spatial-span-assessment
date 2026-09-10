/* ============================================================
   store.js — 녹화 저장·보관·파기

   두 층으로 나뉜다.
     Retention  보관기간 계산과 파기 대상 판정. 순수 로직 → 테스트 대상
     IdbStore   브라우저 IndexedDB 구현. 운영에서는 암호화 객체 저장소로 교체

   운영 저장소가 지켜야 할 것 (설계도 R-05):
     저장 시 암호화 · 서명 URL · 조회 이력 · retentionUntil 기반 자동 파기
   ============================================================ */
(function (global) {
  'use strict';

  /* ---------- 보관 정책 (설계도 §7 제안값 — D-3에서 확정) ---------- */
  var Retention = {
    POLICY: {
      mediaDays: 30,          // 원본 영상·음성
      transcriptDays: 365,    // 전사
      scoreDays: 365 * 3      // 점수·근거
    },

    /** 채용 종료일 기준. 아직 종료 전이면 세션 시작일로 임시 계산한다 */
    until: function (baseIso, days) {
      var base = new Date(baseIso);
      return new Date(base.getTime() + days * 86400000).toISOString();
    },

    plan: function (session, policy) {
      policy = policy || Retention.POLICY;
      var base = session.hiringClosedAt || session.startedAt;
      return {
        basis: session.hiringClosedAt ? 'hiring_closed' : 'session_start_provisional',
        media: Retention.until(base, policy.mediaDays),
        transcript: Retention.until(base, policy.transcriptDays),
        score: Retention.until(base, policy.scoreDays)
      };
    },

    /** 지금 파기해야 할 항목 */
    due: function (session, nowIso) {
      var now = new Date(nowIso || Date.now()).getTime();
      var r = session.retention || {};
      return {
        media: !!r.media && new Date(r.media).getTime() <= now,
        transcript: !!r.transcript && new Date(r.transcript).getTime() <= now,
        score: !!r.score && new Date(r.score).getTime() <= now
      };
    }
  };

  /* ---------- 구간 조립 (순수) ----------
     업로드가 순서대로 도착한다는 보장이 없다. seq로 정렬하고 빠진 구간을 보고한다. */
  var Chunks = {
    order: function (chunks) {
      var sorted = chunks.slice().sort(function (a, b) { return a.seq - b.seq; });
      var missing = [];
      for (var i = 0; i < sorted.length; i++) {
        if (sorted[i].seq !== i) { missing.push(i); }
      }
      var expected = sorted.length ? sorted[sorted.length - 1].seq + 1 : 0;
      var gaps = [];
      var seen = {};
      sorted.forEach(function (c) { seen[c.seq] = true; });
      for (var s = 0; s < expected; s++) if (!seen[s]) gaps.push(s);
      return { sorted: sorted, gaps: gaps, complete: gaps.length === 0, expected: expected };
    }
  };

  /* ---------- IndexedDB 구현 ---------- */
  var DB_NAME = 'interview-proto';
  var DB_VER = 1;

  function openDb() {
    return new Promise(function (resolve, reject) {
      if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB 없음')); return; }
      var req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('chunks')) {
          var cs = db.createObjectStore('chunks', { keyPath: 'key' });
          cs.createIndex('bySession', 'sessionId');
          cs.createIndex('byAnswer', ['sessionId', 'questionId']);
        }
        if (!db.objectStoreNames.contains('audit')) db.createObjectStore('audit', { keyPath: 'id', autoIncrement: true });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function tx(db, stores, mode, fn) {
    return new Promise(function (resolve, reject) {
      var t = db.transaction(stores, mode);
      var out = fn(t);
      t.oncomplete = function () { resolve(out); };
      t.onerror = function () { reject(t.error); };
      t.onabort = function () { reject(t.error); };
    });
  }

  function reqp(r) {
    return new Promise(function (resolve, reject) {
      r.onsuccess = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
    });
  }

  var IdbStore = {
    id: 'idb',
    label: '브라우저 IndexedDB (프로토타입)',
    external: false,
    _db: null,

    open: async function () {
      if (!this._db) this._db = await openDb();
      return this._db;
    },

    audit: async function (type, detail) {
      var db = await this.open();
      await tx(db, ['audit'], 'readwrite', function (t) {
        t.objectStore('audit').add({ type: type, at: Date.now(), detail: detail || null });
      });
    },

    putSession: async function (session) {
      var db = await this.open();
      await tx(db, ['sessions'], 'readwrite', function (t) { t.objectStore('sessions').put(session); });
    },

    getSession: async function (id) {
      var db = await this.open();
      var r = db.transaction('sessions').objectStore('sessions').get(id);
      await this.audit('session_read', id);
      return reqp(r);
    },

    listSessions: async function () {
      var db = await this.open();
      return reqp(db.transaction('sessions').objectStore('sessions').getAll());
    },

    putChunk: async function (sessionId, questionId, seq, blob, meta) {
      var db = await this.open();
      var rec = {
        key: sessionId + '/' + questionId + '/' + String(seq).padStart(5, '0'),
        sessionId: sessionId, questionId: questionId, seq: seq,
        size: blob.size, type: blob.type, blob: blob,
        at: Date.now(), meta: meta || null
      };
      await tx(db, ['chunks'], 'readwrite', function (t) { t.objectStore('chunks').put(rec); });
      return { key: rec.key, size: rec.size };
    },

    listChunks: async function (sessionId, questionId) {
      var db = await this.open();
      var idx = db.transaction('chunks').objectStore('chunks').index('byAnswer');
      var all = await reqp(idx.getAll([sessionId, questionId]));
      return all.map(function (c) { return { key: c.key, seq: c.seq, size: c.size, type: c.type, at: c.at }; });
    },

    /** 조립된 Blob. 조회 이력을 남긴다 — 누가 언제 영상을 봤는지가 감사 대상이다 */
    assemble: async function (sessionId, questionId) {
      var db = await this.open();
      var idx = db.transaction('chunks').objectStore('chunks').index('byAnswer');
      var all = await reqp(idx.getAll([sessionId, questionId]));
      var o = Chunks.order(all);
      await this.audit('media_read', { sessionId: sessionId, questionId: questionId, complete: o.complete });
      if (!o.sorted.length) return null;
      var type = o.sorted[0].type || 'video/webm';
      return { blob: new Blob(o.sorted.map(function (c) { return c.blob; }), { type: type }), gaps: o.gaps, complete: o.complete };
    },

    deleteMedia: async function (sessionId) {
      var db = await this.open();
      var idx = db.transaction('chunks').objectStore('chunks').index('bySession');
      var keys = await reqp(idx.getAllKeys(sessionId));
      await tx(db, ['chunks'], 'readwrite', function (t) {
        var s = t.objectStore('chunks');
        keys.forEach(function (k) { s.delete(k); });
      });
      return keys.length;
    },

    /**
     * 자동 파기. 페이지 로드마다 돈다 — 운영에서는 배치 작업이다.
     * 파기 사실 자체는 감사 기록으로 남긴다 (무엇을 언제 지웠는지).
     */
    purgeExpired: async function (nowIso) {
      var sessions = await this.listSessions();
      var report = [];
      for (var i = 0; i < sessions.length; i++) {
        var s = sessions[i];
        var due = Retention.due(s, nowIso);
        var did = {};
        if (due.media && !s.purged_media) {
          did.mediaChunks = await this.deleteMedia(s.id);
          s.purged_media = new Date().toISOString();
        }
        if (due.transcript && !s.purged_transcript) {
          (s.answers || []).forEach(function (a) { a.transcript = null; });
          s.purged_transcript = new Date().toISOString();
          did.transcript = true;
        }
        if (due.score && !s.purged_score) {
          s.score = null;
          s.purged_score = new Date().toISOString();
          did.score = true;
        }
        if (Object.keys(did).length) {
          await this.putSession(s);
          await this.audit('purge', { sessionId: s.id, did: did });
          report.push({ sessionId: s.id, did: did });
        }
      }
      return report;
    },

    /** 응시자 삭제 요청 — 전부 즉시 */
    eraseSession: async function (sessionId) {
      var db = await this.open();
      var n = await this.deleteMedia(sessionId);
      await tx(db, ['sessions'], 'readwrite', function (t) { t.objectStore('sessions').delete(sessionId); });
      await this.audit('erase_request', { sessionId: sessionId, mediaChunks: n });
      return n;
    }
  };

  global.Retention = Retention;
  global.Chunks = Chunks;
  global.IdbStore = IdbStore;

  if (global.Providers) global.Providers.register('store', IdbStore);
})(typeof window !== 'undefined' ? window : global);
