const sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
const appEl = document.getElementById("app");
const headerEl = document.getElementById("student-name-header");

const CATEGORY_LABEL = { internal_medicine: "内科系", surgery: "外科系" };
const INSTITUTION_LABEL = { internal: "院内", external: "院外" };
const COMBO_LABEL = { IN_N: "院内・内科系", IN_G: "院内・外科系", EX_N: "院外・内科系", EX_G: "院外・外科系" };

function getToken() {
  const params = new URLSearchParams(window.location.search);
  return params.get("token");
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s ?? "";
  return d.innerHTML;
}

function fmtDate(d) {
  return new Date(d).toLocaleString("ja-JP");
}

function requiresLodging(slot) {
  const acc = slot.facility_accommodation || slot.accommodation || "";
  return acc.includes("○");
}

// 地域枠・県民枠（黒潮PJ）の学生は【一般枠】を選べず、【地・県枠】は地域枠・県民枠の学生だけが選べる。【一般枠可能】は全員選べる
function quotaAllows(slot, quota) {
  const dep = (slot && slot.department_name) || "";
  if (dep.includes("【地・県枠】")) return !!quota;
  if (dep.includes("【一般枠可能】")) return true; // 一般枠可能は全員選べる
  if (dep.includes("【一般枠】")) return !quota;
  return true;
}

// ============================================================
// 詰み判定（3:3ルールを満たして6クールを揃えられる空き枠が残っているか）
// ・確定済みの人数だけで判定（今回の希望者との取り合いは考えない＝最善ケース）
// ・黒潮の行は追加枠(NEW)のクールだけ、留学は対象外、施設全体の上限も考慮
// ============================================================
function stuckComboKey(x) {
  return (x.institution_type === "internal" ? "IN" : "EX") + "_" + (x.category === "internal_medicine" ? "N" : "G");
}
function stuckIsKuroshio(s) {
  return (s.department_name || "").includes("黒潮医療人養成プロジェクト") || (s.facility_name || "").includes("黒潮医療人養成プロジェクト");
}
function stuckIsAbroad(s) {
  const n = s.facility_name || "";
  return n.startsWith("留学(") || n.startsWith("留学（");
}
// slots: 有効な枠, assignRows: 全員の確定 [{slot_id, course_number}], limitMap: {施設名: max_total}
function buildStuckAvailability(slots, assignRows, limitMap, allowFn) {
  const slotById = {};
  slots.forEach(s => { slotById[s.id] = s; });
  const used = {}, facUsed = {};
  (assignRows || []).forEach(a => {
    used[a.slot_id + "_" + a.course_number] = (used[a.slot_id + "_" + a.course_number] || 0) + 1;
    const s = slotById[a.slot_id];
    if (s) facUsed[s.facility_name + "_" + a.course_number] = (facUsed[s.facility_name + "_" + a.course_number] || 0) + 1;
  });
  const avail = {};
  for (let c = 1; c <= 6; c++) avail[c] = { IN_N: false, IN_G: false, EX_N: false, EX_G: false };
  for (const s of slots) {
    if (s.active === false || stuckIsAbroad(s)) continue;
    if (allowFn && !allowFn(s)) continue;
    const kuro = stuckIsKuroshio(s);
    for (let c = 1; c <= 6; c++) {
      const cap = s["cap_" + c] || 0;
      if (cap <= 0) continue;
      if (kuro && !(Array.isArray(s.new_courses) && s.new_courses.map(Number).includes(c))) continue;
      if ((used[s.id + "_" + c] || 0) >= cap) continue;
      const lim = limitMap[s.facility_name];
      if (lim != null && (facUsed[s.facility_name + "_" + c] || 0) >= lim) continue;
      avail[c][stuckComboKey(s)] = true;
    }
  }
  return avail;
}
// myAssigns: [{course_number, count_exempt, institution_type, category}]
function isStudentStuck(myAssigns, avail) {
  const keys = ["IN_N", "IN_G", "EX_N", "EX_G"];
  const counts = { IN_N: 0, IN_G: 0, EX_N: 0, EX_G: 0 };
  let inN = 0, exN = 0;
  const filled = new Set();
  for (const a of myAssigns) {
    filled.add(a.course_number);
    if (a.institution_type === "internal") inN++; else exN++;
    if (!a.count_exempt) counts[stuckComboKey(a)]++;
  }
  if (filled.size >= 6) return false;
  const open = [1, 2, 3, 4, 5, 6].filter(c => !filled.has(c));
  const targets = [1, 2].map(a => ({ IN_N: a, IN_G: 3 - a, EX_N: 3 - a, EX_G: a }));
  function dfs(i, inCnt, exCnt) {
    if (inCnt > 3 || exCnt > 3) return false;
    if (!targets.some(t => keys.every(k => counts[k] <= t[k]))) return false;
    if (i === open.length) return inCnt === 3 && exCnt === 3 && keys.every(k => counts[k] >= 1);
    for (const k of keys) {
      if (!avail[open[i]][k]) continue;
      counts[k]++;
      const ok = dfs(i + 1, inCnt + (k.startsWith("IN") ? 1 : 0), exCnt + (k.startsWith("EX") ? 1 : 0));
      counts[k]--;
      if (ok) return true;
    }
    return false;
  }
  return !dfs(0, inN, exN);
}

// ラウンドの表示名（キャンペーンなど特別なラウンドは title を使う）
function roundLabel(r) {
  return (r && r.title) ? r.title : `第${r ? r.round_number : "?"}希望`;
}
// キャンペーンラウンドの参加資格：院外外科を2つ取っていて、院外が3つ揃っている人
// キャンペーンの対象から個別に外す人（留学などで院外外科が元々揃っていた人：浦野さん・関口さん・生駒さん・竹田さん）
const CAMPAIGN_EXCLUDED_SURNAMES = ["浦野", "関口", "生駒", "竹田"];
const CAMPAIGN_EXCLUDED_NUMBERS = [10, 39, 43]; // 浦野さん(10)・関口さん(39)・竹田さん(43)。名前の表記ゆれ対策で番号でも判定
function isCampaignExcluded(nameOrStudent) {
  const st = (nameOrStudent && typeof nameOrStudent === "object") ? nameOrStudent : null;
  if (st && CAMPAIGN_EXCLUDED_NUMBERS.includes(Number(st.attendance_number))) return true;
  const n = ((st ? st.name : nameOrStudent) || "").replace(/[\s\u3000]/g, "");
  return CAMPAIGN_EXCLUDED_SURNAMES.some(x => n.startsWith(x));
}
function isCampaignEligible(round, counts, instCounts, student) {
  if (!round || round.eligibility !== "ext_surgery_2") return true;
  if (student && isCampaignExcluded(student)) return false;
  return counts.EX_G >= 2 && instCounts.external >= 3;
}

function isKuroshioSlot(slot) {
  return slot.department_name.includes("黒潮医療人養成プロジェクト") || slot.facility_name.includes("黒潮医療人養成プロジェクト");
}

function needsLodgingReminder(slot) {
  const isKuroshio = slot.department_name.includes("黒潮医療人養成プロジェクト") || slot.facility_name.includes("黒潮医療人養成プロジェクト");
  return requiresLodging(slot) && !isKuroshio;
}

function ensureRefreshButton() {
  if (document.getElementById("refresh-fab")) return;
  const btn = document.createElement("button");
  btn.id = "refresh-fab";
  btn.className = "refresh-fab";
  btn.textContent = "↻ 更新";
  btn.onclick = () => location.reload();
  document.body.appendChild(btn);

  const rulesBtn = document.createElement("button");
  rulesBtn.id = "rules-fab";
  rulesBtn.className = "rules-fab";
  rulesBtn.textContent = "📖 決め方のルール";
  rulesBtn.onclick = openRulesModal;
  document.body.appendChild(rulesBtn);

  const scheduleBtn = document.createElement("button");
  scheduleBtn.id = "schedule-fab";
  scheduleBtn.className = "schedule-fab";
  scheduleBtn.textContent = "📅 全体スケジュール";
  scheduleBtn.onclick = openScheduleModal;
  document.body.appendChild(scheduleBtn);
}

async function openScheduleModal() {
  ensureModalRoot();
  const root = document.getElementById("facility-modal-root");
  root.innerHTML = `
    <div class="modal-backdrop" id="schedule-backdrop">
      <div class="modal-box rules-box">
        <div class="flex-between">
          <b>第6希望までの全体スケジュール</b>
          <button class="small secondary" id="schedule-close-btn">閉じる</button>
        </div>
        <div class="rules-content" id="schedule-content">読み込み中...</div>
      </div>
    </div>
  `;
  document.getElementById("schedule-close-btn").onclick = closeFacilityModal;
  document.getElementById("schedule-backdrop").addEventListener("click", (e) => {
    if (e.target.id === "schedule-backdrop") closeFacilityModal();
  });

  const { data: rounds0 } = await sb.from("rounds").select("*");
  const rounds = (rounds0 || []).slice().sort((a, b) => (a.display_order ?? a.round_number) - (b.display_order ?? b.round_number));
  const contentEl = document.getElementById("schedule-content");
  if (!contentEl) return; // モーダルが閉じられていたら何もしない

  const phaseLabel = { first_choice: "希望受付中", first_choice_processing: "抽選処理中", second_match: "2次マッチング中", second_match_processing: "抽選処理中", closed: "終了" };
  const nowTs = Date.now();

  if (!rounds || rounds.length === 0) {
    contentEl.innerHTML = `<p>まだラウンドは作成されていません。事務局からの案内をお待ちください。</p>`;
    return;
  }

  const rows = rounds.map(r => {
    const notStartedYet = r.start_at && nowTs < new Date(r.start_at).getTime();
    let statusHtml;
    if (r.phase === "closed") {
      statusHtml = "終了";
    } else if (r.is_current && notStartedYet) {
      statusHtml = `<span style="color:#b3413a;font-weight:700;">開始前</span>`;
    } else if (r.is_current) {
      statusHtml = `<span style="color:#2e7d6b;font-weight:700;">${phaseLabel[r.phase] || r.phase}</span>`;
    } else {
      statusHtml = "予定";
    }
    return `
    <tr>
      <td><b>${esc(roundLabel(r))}</b></td>
      <td>${statusHtml}</td>
      <td class="small-muted">
        開始: ${r.start_at ? fmtDate(r.start_at) : "未定"}<br/>
        1次締切: ${r.end_at ? fmtDate(r.end_at) : "未定"}<br/>
        2次締切: ${r.second_deadline ? fmtDate(r.second_deadline) : "未定"}
      </td>
    </tr>
  `;
  }).join("");

  contentEl.innerHTML = `
    <table class="slots">
      <thead><tr><th>ラウンド</th><th>状態</th><th>日程</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="small-muted" style="margin-top:10px;">まだ作成されていないラウンドの日程は「未定」と表示されます。日程は状況により前後する場合があります。</p>
  `;
}

function openRulesModal() {
  ensureModalRoot();
  const root = document.getElementById("facility-modal-root");
  root.innerHTML = `
    <div class="modal-backdrop" id="rules-backdrop">
      <div class="modal-box rules-box">
        <div class="flex-between">
          <b>実習先の決め方について</b>
          <button class="small secondary" id="rules-close-btn">閉じる</button>
        </div>
        <div class="rules-content">

<p>今回の実習先の決め方について説明します！</p>

<p>基本的には、①〜⑥クールを順番に決めるのではなく、「第1希望→第2希望→…→第6希望」という形で、全員一緒に1枠ずつ決めていく方式にします。</p>

<p><b>■ 進め方について</b></p>
<ul>
<li>基本的に1ラウンドは2日間ずつで進めます（1次締切・2次締切あわせて）。</li>
<li>全ラウンド（第6希望まで）が終了した後に、お互いのトレード（交換）の期間も設ける予定です。</li>
</ul>

<p><b>■ どうやって希望を出す？</b></p>
<p>第1希望では、まだ自分の実習先が決まっていない①〜⑥クールの中から、自分が一番優先したい「時期×実習先」を1つ選んで希望を出してください。</p>
<p>例えば、</p>
<ul>
<li>就活のために⑤・⑥クールはなるべく余裕のある科に行きたい</li>
<li>①〜④クールで自分の進路に関係する科に行きたい</li>
<li>この病院・この診療科には絶対行きたい</li>
</ul>
<p>など、人によって優先したいことが違うと思います。そのため、全員が同じクールから順番に決めるのではなく、「自分にとって何が一番大事か」を自分で考えて、第1希望から順番に取っていく方式にしています。</p>
<p>全員の第1希望のラウンドが終わったら第2希望、その次は第3希望……という形で進め、最終的に⑥クールまで決めていきます。</p>
<p>イメージとしては「全員で1枠ずつ進む。ただし、何を1枠目・2枠目にするかは自分で決める」という感じです！</p>

<p><b>■ 希望者の名前について</b></p>
<p>基本的に、希望提出中は匿名です。その枠に現在何人希望しているかは確認できますが、誰が希望しているかは分からないようにします。</p>
<p>ただし、宿泊が関係する病院については、部屋割り等の調整が必要になるため、希望提出の段階から名前を公開します。</p>
<p>通常の枠については、1次締切後に抽選または定員内での確定が行われ、枠が確定した時点で確定者の名前が全員に表示されます。2次マッチングも同様に、希望提出中は基本匿名で、確定後に名前が表示されます。</p>

<p><b>■ 希望が被った場合</b></p>
<p>早い者勝ちではありません。締切までは定員を超えていても希望を出すことができます。</p>
<ul>
<li>1次締切の時点で定員以内 → そのまま確定</li>
<li>定員オーバー → システムでランダム抽選</li>
<li>抽選で外れた → 空いている枠で2次マッチング</li>
</ul>

<p><b>■ 2次マッチングについて</b></p>
<p>多くの方が登録した時点で、抽選に外れそうな人数を確認します。</p>
<ul>
<li><b>5人以上の場合</b> → 3次マッチングを行い、空いている枠から2次マッチングに落ちた人で選び直します。(期限はまたその時に決めます)</li>
<li><b>5人未満の場合</b> → そのまま抽選を行います。外れた方には、次のラウンドが始まるまでに坂本がグループLINEを作成しますので、空いている枠から相談して決めてください。<br/>※希望が重ならないよう、グループ内で調整をお願いします🙇‍♀️</li>
</ul>

<p><b>■ 2次マッチングのお願い</b></p>
<p>同じ枠に希望が集中すると、抽選や追加のマッチングが繰り返されてしまいます。できるだけほかの方と重ならないよう、空いている枠から選んでいただけると助かります。</p>

<p><b>■ 院内3・院外3、内科3・外科3について</b></p>
<p>要件を満たせるように、アプリ上で現在の取得状況を確認できるようにしています。</p>
<p>また、選択した結果、最終的に必要な組み合わせを満たせなくなることが分かっている場合は、該当する枠を選択できないようにします。</p>
<p>ただし、第6ラウンド終盤など、必要な「院外・内科系」等の枠そのものが残っていないという状況が発生する可能性はあります。その場合については、こちらだけで無理に決めるのではなく、学生課と相談のうえで個別に調整します。状況によっては、例外的に院内が4クールになるなど、通常の3:3から変更が必要になる可能性もあります。このあたりは実際の残り枠の状況によるため、その時点で相談して対応します。</p>

<p><b>■ 地域枠・県民枠・留学について</b></p>
<p>地域枠・県民枠・留学に行く人は、すでにいくつかのクールが確定した状態でスタートします。そのため早く決まるというメリットがありますが、どちらも「義務」であり「選抜のうえで得た1枠」です。その点はご理解をお願いします🙏</p>


        </div>
      </div>
    </div>
  `;
  document.getElementById("rules-close-btn").onclick = closeFacilityModal;
  document.getElementById("rules-backdrop").addEventListener("click", (e) => {
    if (e.target.id === "rules-backdrop") closeFacilityModal();
  });
}

function startCountdown(targetIso, elId, doneText) {
  elId = elId || "countdown-timer";
  doneText = doneText || "まもなく処理されます…";
  const target = new Date(targetIso).getTime();
  const timerEl = document.getElementById(elId);
  if (!timerEl) return;
  function tick() {
    const el = document.getElementById(elId);
    if (!el) return; // ページが差し替わったら停止
    const diff = target - Date.now();
    if (diff <= 0) {
      el.textContent = doneText;
      clearInterval(intervalId);
      return;
    }
    const h = Math.floor(diff / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    const s = Math.floor((diff % 60000) / 1000);
    el.textContent = `残り ${h}時間${String(m).padStart(2,"0")}分${String(s).padStart(2,"0")}秒`;
  }
  tick();
  const intervalId = setInterval(tick, 1000);
}

function renderResultAnimation(kind) {
  if (kind === "win") {
    return `<div class="result-fx result-win">
      <div class="confetti">${"🎉🎊✨🎈".split("").map((c,i)=>`<span style="--i:${i}">${c}</span>`).join("")}</div>
      <div class="result-fx-text">抽選、当選！</div>
    </div>`;
  }
  if (kind === "smooth") {
    return `<div class="result-fx result-smooth">
      <div class="result-fx-text">✅ 無事に確定しました</div>
    </div>`;
  }
  if (kind === "lose" || kind === "lose-once") {
    return `<div class="result-fx result-lose">
      <div class="result-fx-text">😢 1次マッチングに外れました。2次マッチングに進んでください！</div>
    </div>`;
  }
  if (kind === "lose-final") {
    return `<div class="result-fx result-lose">
      <div class="result-fx-text">📣 2次マッチングも外れました。希望があれば坂本まで至急ご連絡を。</div>
    </div>`;
  }
  return "";
}

// 締切後にページを開いた瞬間、結果が一目で分かる全画面の演出（同じ結果は1回だけ表示）
function maybeShowResultReveal(prefId, kind, detailText) {
  if (!prefId || !kind) return;
  const seenKey = "result_seen_" + prefId + "_" + kind;
  if (localStorage.getItem(seenKey)) return;
  localStorage.setItem(seenKey, "1");

  ensureModalRoot();
  const root = document.getElementById("facility-modal-root");
  const configs = {
    win: { bg: "linear-gradient(135deg,#fff8e1,#ffe9b3)", emoji: "🎉", title: "当選しました！", color: "#a86a00", confetti: true },
    smooth: { bg: "#eaf6f0", emoji: "✅", title: "確定しました", color: "#1e6b3a", confetti: false },
    lose: { bg: "#f3f3f3", emoji: "😢", title: "1次マッチングに外れました", color: "#6b7680", confetti: false },
    "lose-final": { bg: "#fdf1ec", emoji: "📣", title: "2次マッチングも外れてしまいました", color: "#b3413a", confetti: false },
    alldone: { bg: "linear-gradient(135deg,#e3f3ff,#d3e8ff)", emoji: "🏁", title: "お疲れ様でした！", color: "#1c3a5e", confetti: true },
  };
  const cfg = configs[kind] || configs.smooth;

  root.innerHTML = `
    <div class="modal-backdrop reveal-backdrop" id="reveal-backdrop">
      <div class="reveal-box" style="background:${cfg.bg};">
        ${cfg.confetti ? `<div class="confetti">${"🎉🎊✨🎈🎉🎊".split("").map((c,i)=>`<span style="--i:${i}">${c}</span>`).join("")}</div>` : ""}
        <div class="reveal-emoji">${cfg.emoji}</div>
        <div class="reveal-title" style="color:${cfg.color};">${cfg.title}</div>
        <div class="reveal-detail">${esc(detailText || "")}</div>
        <button class="secondary" id="reveal-close-btn">閉じる</button>
      </div>
    </div>
  `;
  document.getElementById("reveal-close-btn").onclick = closeFacilityModal;
  document.getElementById("reveal-backdrop").addEventListener("click", (e) => {
    if (e.target.id === "reveal-backdrop") closeFacilityModal();
  });
}

function comboKeyOf(slot) {
  const inst = slot.institution_type === "internal" ? "IN" : "EX";
  const cat = slot.category === "internal_medicine" ? "N" : "G";
  return inst + "_" + cat;
}

// 4つの組み合わせ(院内内科・院内外科・院外内科・院外外科)は必ず1回以上、
// 残り2つは「院内内科+院外外科をもう1回ずつ」または「院外内科+院内外科をもう1回ずつ」
// の2パターンしかない。counts={IN_N,IN_G,EX_N,EX_G} に対し、まだ成立しうる配分(a)を返す。
function feasiblePatterns(counts) {
  const patterns = [1, 2]; // a=1→(1,2,2,1), a=2→(2,1,1,2)
  return patterns.filter(a => {
    const target = { IN_N: a, IN_G: 3 - a, EX_N: 3 - a, EX_G: a };
    return Object.keys(target).every(k => counts[k] <= target[k]);
  });
}

function comboEligible(counts, comboKey, feasible) {
  return feasible.some(a => {
    const target = { IN_N: a, IN_G: 3 - a, EX_N: 3 - a, EX_G: a };
    return counts[comboKey] < target[comboKey];
  });
}

// ============================================================
// 施設詳細モーダル
// ============================================================
function ensureModalRoot() {
  if (document.getElementById("facility-modal-root")) return;
  const div = document.createElement("div");
  div.id = "facility-modal-root";
  document.body.appendChild(div);
}
function closeFacilityModal() {
  const root = document.getElementById("facility-modal-root");
  if (root) root.innerHTML = "";
  // 結果発表などの後に表示待ちのお願いポップアップがあれば、閉じた直後に表示する
  if (window.__popupQueue && window.__popupQueue.length > 0) {
    const fn = window.__popupQueue.shift();
    setTimeout(fn, 200);
  }
}

// 他のモーダルが開いていれば閉じた後に、開いていなければすぐに表示する（複数あれば順番に）
function showOrQueuePopup(fn) {
  ensureModalRoot();
  const root = document.getElementById("facility-modal-root");
  window.__popupQueue = window.__popupQueue || [];
  if (root && root.innerHTML.trim()) window.__popupQueue.push(fn);
  else fn();
}

// ポップアップは同じ内容を3時間ごとに再表示する（前回表示から3時間たっていなければ出さない）
const POPUP_INTERVAL_MS = 3 * 60 * 60 * 1000;
function popupDue(key) {
  const k = "v2_" + key; // 実験で出したものはリセットし、この版から数え直す
  try {
    const last = Number(localStorage.getItem(k) || 0);
    if (last && Date.now() - last < POPUP_INTERVAL_MS) return false;
    localStorage.setItem(k, String(Date.now()));
  } catch (e) { /* 保存できなくても表示はする */ }
  return true;
}

// 宿泊の回答がまだの人へのポップアップ（3時間ごと）
function maybeShowLodgingPopup(student, unanswered, lodgingSettings) {
  if (!popupDue(`lodging_popup_${student.id}`)) return;
  const list = unanswered
    .slice().sort((a, b) => a.course_number - b.course_number)
    .map(a => `・${window.COURSE_LABELS[a.course_number - 1]} ${a.slots.facility_name} ${a.slots.department_name}`)
    .join("\n");
  const dl = lodgingSettings && lodgingSettings.deadline ? fmtDate(lodgingSettings.deadline) : "10/6";
  showOrQueuePopup(() => {
    const root = document.getElementById("facility-modal-root");
    const body = `次の実習先について、宿泊するかどうかの回答がまだです。\n\n${list}\n\n画面上部の「宿泊するかどうかの回答」から、「宿泊する」か「宿泊しない」を選んでください。\n回答期限：${dl}\n\n期限までに回答がない場合は、宿泊なしとして扱われ、原則として後から変更できません。`;
    root.innerHTML = `
      <div class="modal-backdrop reveal-backdrop" id="lodging-backdrop">
        <div class="reveal-box" style="background:#fdf1ec;">
          <div class="reveal-emoji">🏨</div>
          <div class="reveal-title" style="color:#b3413a;">宿泊の回答をお願いします</div>
          <div class="reveal-detail" style="text-align:left;">${esc(body)}</div>
          <button class="secondary" id="lodging-close-btn">わかりました</button>
        </div>
      </div>
    `;
    document.getElementById("lodging-close-btn").onclick = closeFacilityModal;
  });
}

// 全ラウンド終了のお知らせポップアップ（3時間ごと）
function maybeShowAllEndedPopup(student) {
  if (!popupDue(`all_ended_popup_${student.id}`)) return;
  showOrQueuePopup(() => {
    const root = document.getElementById("facility-modal-root");
    const body = `第6希望まですべてのラウンドが終了しました。お疲れ様でした！\n\n残りの手続きはこちらです：\n${window.__endedItemsText || ""}`;
    root.innerHTML = `
      <div class="modal-backdrop reveal-backdrop" id="allended-backdrop">
        <div class="reveal-box" style="background:linear-gradient(135deg,#eaf6f0,#d9f0e0);">
          <div class="confetti">${["🎉","🎊","✨","🎉"].map((e,i)=>`<span style="--i:${i}">${e}</span>`).join("")}</div>
          <div class="reveal-emoji">🎉</div>
          <div class="reveal-title" style="color:#1e6b3a;">全ラウンド終了しました！</div>
          <div class="reveal-detail" style="text-align:left;">${esc(body)}</div>
          <button class="secondary" id="allended-close-btn">わかりました</button>
        </div>
      </div>
    `;
    document.getElementById("allended-close-btn").onclick = closeFacilityModal;
  });
}

// 詰みの人へのお知らせポップアップ（ラウンドごとに1回）
function maybeShowStuckPopup(student, round) {
  const key = `stuck_popup_${student.id}_${round ? round.id : "none"}`;
  if (!popupDue(key)) return;
  showOrQueuePopup(() => {
    const root = document.getElementById("facility-modal-root");
    const body = "現在、3:3のルールを満たして6クールを揃えられる空き枠が残っていない状態です。\n\n全ラウンドが終わった後に個別に対応しますので、しばらくお待ちください。";
    root.innerHTML = `
      <div class="modal-backdrop reveal-backdrop" id="stuck-backdrop">
        <div class="reveal-box" style="background:#f3f3f3;">
          <div class="reveal-emoji">🙇</div>
          <div class="reveal-title" style="color:#b3413a;">空き枠についてのお知らせ</div>
          <div class="reveal-detail" style="text-align:left;">${esc(body)}</div>
          <button class="secondary" id="stuck-close-btn">わかりました</button>
        </div>
      </div>
    `;
    document.getElementById("stuck-close-btn").onclick = closeFacilityModal;
  });
}

// 第4希望：院外外科を2つ取ってくれた人へのお礼ポップアップ（回ごとに1回）
function maybeShowCampaignThanksPopup(student, round, attempt, onlyExtNaika) {
  const key = `campaign_thanks_popup_${student.id}_${round.id}_${attempt}`;
  if (!popupDue(key)) return;
  showOrQueuePopup(() => {
    const root = document.getElementById("facility-modal-root");
    const body = onlyExtNaika
      ? `院外・外科系を先行して2つ選んでいただき、ありがとうございます！\n\nあなたは3:3のルール上、院外・内科系があと1つ必要なため、${roundLabel(round)}では院外・内科系の枠のみ選択できます。\n\n院外・内科系を取っていただければ、このラウンドが終了した後に、ひと枠先行して決められる枠をプレゼントします。`
      : `院外・外科系を先行して2つ選んでいただき、ありがとうございます！\n\n${roundLabel(round)}では何を選んでいただいても、このラウンドが終了した後に、ひと枠先行して決められる枠をプレゼントします。`;
    root.innerHTML = `
      <div class="modal-backdrop reveal-backdrop" id="thanks-backdrop">
        <div class="reveal-box" style="background:linear-gradient(135deg,#fff8e1,#ffe9b3);">
          <div class="confetti">${["🎉","🎁","✨","🎊"].map((e,i)=>`<span style="--i:${i}">${e}</span>`).join("")}</div>
          <div class="reveal-emoji">🎁</div>
          <div class="reveal-title" style="color:#a86a00;">ありがとうございます！</div>
          <div class="reveal-detail" style="text-align:left;">${esc(body)}</div>
          <button class="secondary" id="thanks-close-btn">わかりました</button>
        </div>
      </div>
    `;
    document.getElementById("thanks-close-btn").onclick = closeFacilityModal;
  });
}

// 第4希望：院外外科を取ればキャンペーンで1枠先行して決められることを案内するポップアップ（回ごとに1回）
function maybeShowCampaignInvitePopup(student, round, attempt) {
  const key = `campaign_invite_popup_${student.id}_${round.id}_${attempt}`;
  if (!popupDue(key)) return;
  showOrQueuePopup(() => {
    const root = document.getElementById("facility-modal-root");
    const body = `あなたは今、院外・内科系と院外・外科系を1つずつ取っています。\n\n今回の${roundLabel(round)}で「院外・外科系」を取っていただけたら、次の「院外外科2個取ってくれてありがとうキャンペーン」に参加でき、ほかの人より先に1枠決められるチャンスがあります。\n\n院外内科は残り枠が少なく、必要としている人が多いため、ご協力いただけると助かります。`;
    root.innerHTML = `
      <div class="modal-backdrop reveal-backdrop" id="invite-backdrop">
        <div class="reveal-box" style="background:linear-gradient(135deg,#fff8e1,#ffe9b3);">
          <div class="reveal-emoji">🎁</div>
          <div class="reveal-title" style="color:#a86a00;">院外外科を選ぶとチャンスがあります</div>
          <div class="reveal-detail" style="text-align:left;">${esc(body)}</div>
          <button class="secondary" id="invite-close-btn">わかりました</button>
        </div>
      </div>
    `;
    document.getElementById("invite-close-btn").onclick = closeFacilityModal;
  });
}

// 第4希望：院外内科が足りていない人に、院外内科しか選べないことを知らせるポップアップ（回ごとに1回）
function maybeShowForceExtNaikaPopup(student, round, attempt) {
  const key = `force_extnaika_popup_${student.id}_${round.id}_${attempt}`;
  if (!popupDue(key)) return;
  showOrQueuePopup(() => {
    const root = document.getElementById("facility-modal-root");
    const body = `あなたは、3:3のルールを満たすために必要な「院外・内科系」がまだ足りていません。\n\n院外内科は残り枠が少ないため、${roundLabel(round)}では（2次マッチングも含めて）院外・内科系の枠しか選べないようにしています。表のそれ以外の枠はタップできなくなっています。`;
    root.innerHTML = `
      <div class="modal-backdrop reveal-backdrop" id="forcenaika-backdrop">
        <div class="reveal-box" style="background:#fdf1ec;">
          <div class="reveal-emoji">🏥</div>
          <div class="reveal-title" style="color:#b3413a;">今回は院外・内科系のみ選択できます</div>
          <div class="reveal-detail" style="text-align:left;">${esc(body)}</div>
          <button class="secondary" id="forcenaika-close-btn">わかりました</button>
        </div>
      </div>
    `;
    document.getElementById("forcenaika-close-btn").onclick = closeFacilityModal;
  });
}

// 第4希望：院外がまだ3つ揃っていない人は院外しか選べないことを知らせるポップアップ（回ごとに1回）
function maybeShowForceExternalPopup(student, round, attempt, externalCount) {
  const key = `force_ext_popup_${student.id}_${round.id}_${attempt}`;
  if (!popupDue(key)) return;
  const rest = 3 - externalCount;
  showOrQueuePopup(() => {
    const root = document.getElementById("facility-modal-root");
    const body = `あなたはまだ院外が${externalCount}/3で、あと${rest}つ院外を取る必要があります。\n\n${roundLabel(round)}では（2次マッチングも含めて）、院外がまだ3つ揃っていない人は院外の枠しか選べません。表の院内の枠はタップできなくなっています。`;
    root.innerHTML = `
      <div class="modal-backdrop reveal-backdrop" id="forceext-backdrop">
        <div class="reveal-box" style="background:#fdf1ec;">
          <div class="reveal-emoji">🚑</div>
          <div class="reveal-title" style="color:#b3413a;">今回は院外のみ選択できます</div>
          <div class="reveal-detail" style="text-align:left;">${esc(body)}</div>
          <button class="secondary" id="forceext-close-btn">わかりました</button>
        </div>
      </div>
    `;
    document.getElementById("forceext-close-btn").onclick = closeFacilityModal;
  });
}

// ============================================================
// 院外内科についてのお願いポップアップ（ラウンド・回ごとに1回だけ表示）
// ============================================================
function exnNeedRange(counts) {
  // まだ成立しうる配分ごとに「院外内科があと何枠必要か」を出し、最小(必須数)と最大(取れる上限)を返す
  const feasible = feasiblePatterns(counts);
  if (feasible.length === 0) return { min: 0, max: 0 };
  const rest = feasible.map(a => Math.max(0, (3 - a) - counts.EX_N));
  return { min: Math.min(...rest), max: Math.max(...rest) };
}

function showExnPopup(kind, roundNumber) {
  ensureModalRoot();
  const root = document.getElementById("facility-modal-root");
  const cfg = kind === "must"
    ? {
        bg: "#fdf1ec", color: "#b3413a", emoji: "🙏",
        title: "院外・内科系についてのお願い",
        body: `あなたはまだ「院外・内科系」を1つも取っていません。\n\n院外内科は残り枠がかなり少なく、特に①〜③クールは取り合いになっています。院外内科を取れないと3:3のルールを満たせなくなるおそれがあるため、なるべく今回（${roundNumber}）で院外内科を選んでいただけると助かります。`,
      }
    : {
        bg: "#eef4fb", color: "#1c3a5e", emoji: "🤝",
        title: "院外・内科系についてのお願い",
        body: `あなたはすでに「院外・内科系」を取っていて、3:3のルールを満たすうえで、これ以上の院外内科は必須ではありません。\n\n院外内科は残り枠が少なく、まだ1つも取れていない人や必須の人が多くいます。できれば院内・内科系や院外・外科系を優先して選んでもらえると助かります。`,
      };
  root.innerHTML = `
    <div class="modal-backdrop reveal-backdrop" id="exn-backdrop">
      <div class="reveal-box" style="background:${cfg.bg};">
        <div class="reveal-emoji">${cfg.emoji}</div>
        <div class="reveal-title" style="color:${cfg.color};">${cfg.title}</div>
        <div class="reveal-detail" style="text-align:left;">${esc(cfg.body)}</div>
        <button class="secondary" id="exn-close-btn">わかりました</button>
      </div>
    </div>
  `;
  document.getElementById("exn-close-btn").onclick = closeFacilityModal;
}

function maybeShowExnPopup(student, round, attempt, counts, hasExempt) {
  if (!round) return;
  // 院外内科を1つも取っていない人（＝必ず1つ以上必要）にだけ表示する
  if (counts.EX_N !== 0) return;
  const kind = "must";

  const key = `exn_popup_${student.id}_${round.id}_${attempt}_${kind}`;
  if (!popupDue(key)) return;

  showOrQueuePopup(() => showExnPopup(kind, roundLabel(round)));
}
function openFacilityModal(info) {
  ensureModalRoot();
  const root = document.getElementById("facility-modal-root");
  root.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal-box">
        <div class="flex-between">
          <b>${esc(info.facility_name)}</b>
          <button class="small secondary" id="modal-close">閉じる</button>
        </div>
        <table class="slots" style="margin-top:10px;">
          <tbody>
            <tr><td style="width:90px;"><b>宿泊施設</b></td><td>${esc(info.accommodation) || "情報なし"}</td></tr>
            <tr><td><b>集合時間</b></td><td>${esc(info.gather_time) || "情報なし"}</td></tr>
            ${info.limit_note ? `<tr><td><b>人数上限</b></td><td>${esc(info.limit_note)}</td></tr>` : ""}
            ${requiresLodging(info) ? `<tr><td><b>氏名公開</b></td><td>宿泊調整が必要な施設のため、この施設の希望は最初から氏名が表示されます。</td></tr>` : ""}
          </tbody>
        </table>
        <div style="margin-top:10px;">
          <b class="small-muted">実習先からの連絡事項等</b>
          <p class="note-text" style="margin-top:6px;">${esc(info.note) || "特になし"}</p>
        </div>
      </div>
    </div>
  `;
  document.getElementById("modal-close").onclick = closeFacilityModal;
  document.getElementById("modal-backdrop").addEventListener("click", (e) => {
    if (e.target.id === "modal-backdrop") closeFacilityModal();
  });
}

async function main() {
  const token = getToken();
  if (!token) {
    appEl.innerHTML = `<div class="notice warn">個人専用のURLからアクセスしてください。URLに ?token=... が含まれている必要があります。</div>`;
    headerEl.textContent = "";
    return;
  }

  const { data: student, error: studentErr } = await sb
    .from("students")
    .select("*")
    .eq("access_token", token)
    .maybeSingle();

  if (studentErr || !student) {
    appEl.innerHTML = `<div class="notice warn">リンクが無効です。事務局にお問い合わせください。</div>`;
    headerEl.textContent = "";
    return;
  }

  headerEl.textContent = `${student.name}（出席番号 ${student.attendance_number}）`;
  window.__myQuota = student.kuroshio_quota || null; // '地' or '県'（黒潮PJの地域枠・県民枠）
  ensureRefreshButton();

  const { data: round0 } = await sb
    .from("rounds")
    .select("*")
    .eq("is_current", true)
    .maybeSingle();

  const round = await window.tryRunLotteryIfDue(sb, round0);
  if (window.tryRunMoveIfDue) await window.tryRunMoveIfDue(sb); // 空き枠トレードの締切が過ぎていれば抽選

  const { data: assignments } = await sb
    .from("assignments")
    .select("id, course_number, slot_id, count_exempt, lodging_choice, slots(institution_type, category, facility_name, department_name, facility_accommodation, accommodation)")
    .eq("student_id", student.id);

  const { data: lodgingSettings } = await sb.from("lodging_settings").select("*").eq("id", 1).maybeSingle();

  // 希望調査で確定した枠（=黒潮プロジェクトの事前割り当てではない枠）の一覧
  const { data: myConfirmedPrefs } = await sb
    .from("preferences")
    .select("slot_id, course_number, paired_course_number")
    .eq("student_id", student.id)
    .eq("status", "confirmed");
  window.__myConfirmedKeys = new Set();
  (myConfirmedPrefs || []).forEach(p => {
    window.__myConfirmedKeys.add(p.slot_id + "_" + p.course_number);
    if (p.paired_course_number) window.__myConfirmedKeys.add(p.slot_id + "_" + p.paired_course_number);
  });

  renderApp(student, round, assignments || [], lodgingSettings);
}

function computeState(assignments) {
  const counts = { IN_N: 0, IN_G: 0, EX_N: 0, EX_G: 0 };
  const instCounts = { internal: 0, external: 0 };
  const catCounts = { internal_medicine: 0, surgery: 0 };
  const filledCourses = new Set();
  for (const a of assignments) {
    filledCourses.add(a.course_number);
    if (a.count_exempt) {
      // 留学等で「内科/外科どちらでもない」扱いの枠：院内/院外のカウントのみ増やし、内科/外科・4組み合わせの判定には含めない
      instCounts[a.slots.institution_type]++;
    } else {
      counts[comboKeyOf(a.slots)]++;
      instCounts[a.slots.institution_type]++;
      catCounts[a.slots.category]++;
    }
  }
  return { counts, instCounts, catCounts, filledCourses };
}

function attachCancelHandler(student) {
  const btn = document.getElementById("cancel-confirmed-btn");
  if (!btn) return;
  btn.onclick = async () => {
    if (!confirm("本当にこの枠をキャンセルしますか？\n\n押すと元に戻せません。キャンセルすると2次マッチングで改めて選び直すことになります。")) return;
    if (!confirm("最終確認です。キャンセルを実行してよろしいですか？（この操作は取り消せません）")) return;
    const prefId = btn.dataset.prefId;
    const courseNumber = Number(btn.dataset.course);
    const { error: e1 } = await sb.from("preferences").update({ status: "lost", cancelled: true, won_lottery: false }).eq("id", prefId);
    const { data: delData, error: e2 } = await sb.from("assignments").delete().eq("student_id", student.id).eq("course_number", courseNumber).select();
    if (e1 || e2 || !delData || delData.length === 0) {
      alert("キャンセル処理に失敗しました。もう一度お試しいただくか、学年代表にご連絡ください。（枠の削除が反映されませんでした）");
      return;
    }
    location.reload();
  };
}

function attachLodgingHandlers() {
  document.querySelectorAll(".lodging-btn").forEach(btn => {
    btn.onclick = async () => {
      const id = btn.dataset.id;
      const choice = btn.dataset.choice;
      const label = choice === "yes" ? "宿泊する" : "宿泊しない";
      if (!confirm(`「${label}」で回答します。よろしいですか？`)) return;
      // 回答した時刻も記録する（宿泊の順番を出すため）。列がまだない場合は回答だけ保存
      const r = await sb.from("assignments").update({ lodging_choice: choice, lodging_answered_at: new Date().toISOString() }).eq("id", id);
      if (r.error) await sb.from("assignments").update({ lodging_choice: choice }).eq("id", id);
      location.reload();
    };
  });
  document.querySelectorAll(".lodging-change-btn").forEach(btn => {
    btn.onclick = async () => {
      if (!confirm("回答を変更しますか？")) return;
      const r = await sb.from("assignments").update({ lodging_choice: null, lodging_answered_at: null }).eq("id", btn.dataset.id);
      if (r.error) await sb.from("assignments").update({ lodging_choice: null }).eq("id", btn.dataset.id);
      location.reload();
    };
  });
}

// 個別の例外：あとで確定済みの枠を差し替える予定がある人は、差し替え後の内容で3:3ルールを判定する
//  小山さん(34)：⑤クール（有田）をキャンセルして和歌山労災の整形外科（院外・外科系）に行く予定
const PLANNED_SWAPS = [
  { number: 34, surname: "小山", course: 5, institution_type: "external", category: "surgery" },
];
function applyPlannedSwap(student, assignments) {
  const sw = PLANNED_SWAPS.find(x =>
    Number(student.attendance_number) === x.number && (student.name || "").replace(/[\s\u3000]/g, "").startsWith(x.surname));
  if (!sw) return assignments;
  return assignments.map(a => a.course_number === sw.course
    ? Object.assign({}, a, { count_exempt: false, slots: Object.assign({}, a.slots, { institution_type: sw.institution_type, category: sw.category }) })
    : a);
}

async function renderApp(student, round, assignments, lodgingSettings) {
  const { counts, instCounts, catCounts, filledCourses } = computeState(applyPlannedSwap(student, assignments));
  const allDone = filledCourses.size >= 6;
  const feasible = feasiblePatterns(counts);
  const now = new Date();
  const noRound = !round;

  let html = "";

  // 現在のラウンドの状態・締切カウントダウンを、目立つ色で一番上に表示
  const notStarted0 = !noRound && round.start_at && now < new Date(round.start_at);
  const firstEnded0 = !noRound && round.end_at && now > new Date(round.end_at);
  const secondEnded0 = !noRound && round.second_deadline && now > new Date(round.second_deadline);
  const thirdEnded0 = !noRound && round.third_deadline && now > new Date(round.third_deadline);

  let countdownTarget = null, countdownLabel = "";
  if (!noRound && notStarted0) { countdownTarget = round.start_at; countdownLabel = "開始まで"; }
  else if (!noRound && round.phase === "first_choice" && !firstEnded0 && round.end_at) { countdownTarget = round.end_at; countdownLabel = "1次締切まで"; }
  else if (!noRound && round.phase === "second_match" && !secondEnded0 && round.second_deadline) { countdownTarget = round.second_deadline; countdownLabel = "2次締切まで"; }
  else if (!noRound && round.phase === "third_match" && !thirdEnded0 && round.third_deadline) { countdownTarget = round.third_deadline; countdownLabel = "3次締切まで"; }

  const phaseWordMap = { first_choice: "1次希望 受付中", first_choice_processing: "1次 抽選処理中", second_match: "2次マッチング 開催中", second_match_processing: "2次 抽選処理中", third_match: "3次マッチング 開催中", third_match_processing: "3次 抽選処理中", closed: "このラウンドは終了" };

  // ラウンドが終了していて、次のラウンドの開始日時がもう入力されていれば、そのカウントダウンを表示する
  let nextRoundNotice = "";
  if (!noRound && round.phase === "closed") {
    // 表示順（display_order）で次に来るラウンドを探す（キャンペーンなどの特別ラウンドも含む）
    const { data: allRoundsForNext } = await sb.from("rounds").select("start_at, round_number, title, display_order");
    const curOrder = round.display_order ?? round.round_number;
    const nextRound = (allRoundsForNext || [])
      .filter(r => (r.display_order ?? r.round_number) > curOrder)
      .sort((a, b) => (a.display_order ?? a.round_number) - (b.display_order ?? b.round_number))[0];
    if (nextRound && nextRound.start_at && now < new Date(nextRound.start_at)) {
      countdownTarget = nextRound.start_at;
      countdownLabel = `${roundLabel(nextRound)} 開始まで`;
    } else if (!nextRound) {
      window.__allRoundsEnded = true; // 最後のラウンドが終了した
    } else {
      nextRoundNotice = `<div class="small-muted">次のラウンドの開始時刻は、決まり次第お知らせします。</div>`;
    }
  }

  // 全ラウンド終了後：残っている手続き（トレード・宿泊の回答・空き枠トレード）を表示する
  let endedItemsHtml = "";
  if (window.__allRoundsEnded) {
    const md = d => { const x = new Date(d); return `${x.getMonth() + 1}/${x.getDate()}`; };
    const [{ data: ts }, { data: runs }] = await Promise.all([
      sb.from("trade_settings").select("*").eq("id", 1).maybeSingle(),
      sb.from("move_runs").select("*").order("run_number"),
    ]);
    const items = [];
    if (!ts || ts.enabled) items.push(`🔄 友達とのトレード（${ts && ts.end_at ? md(ts.end_at) : "10/6"}まで）`);
    items.push(`🏨 宿泊するかどうかの回答（${lodgingSettings && lodgingSettings.deadline ? md(lodgingSettings.deadline) : "10/6"}まで）`);
    const nowMs = Date.now();
    const openRun = (runs || []).find(r => r.status === "open" && r.start_at && r.deadline && nowMs >= new Date(r.start_at).getTime() && nowMs <= new Date(r.deadline).getTime());
    const nextRun = (runs || []).find(r => r.status === "open" && r.start_at && nowMs < new Date(r.start_at).getTime());
    if (openRun) items.push(`🔁 空き枠トレード 第${openRun.run_number}回 開催中（締切 ${fmtDate(openRun.deadline)}）`);
    else if (nextRun) items.push(`🔁 空き枠トレード 第${nextRun.run_number}回（${fmtDate(nextRun.start_at)} から受付）`);
    endedItemsHtml = items.map(x => `<li>${x}</li>`).join("");
    window.__endedItemsText = items.join("\n");
  }

  if (!noRound && window.__allRoundsEnded) {
    html += `<div class="round-hero">
      <div class="round-hero-title">🎉 全ラウンド終了しました！</div>
      <div style="margin-top:6px;">残りの手続きはこちらです：</div>
      <ul style="margin:6px 0 0;padding-left:20px;line-height:1.8;">${endedItemsHtml}</ul>
    </div>`;
  } else if (!noRound) {
    html += `<div class="round-hero">
      <div class="round-hero-title">${esc(roundLabel(round))} － ${notStarted0 ? "開始前" : (phaseWordMap[round.phase] || round.phase)}</div>
      ${countdownTarget ? `<div class="countdown-box"><span id="countdown-label">${countdownLabel}</span> <span id="countdown-timer">--:--:--</span></div>` : (nextRoundNotice || (!notStarted0 && (round.phase === "second_match" && secondEnded0) || (round.phase === "third_match" && thirdEnded0) || (round.phase === "first_choice" && firstEnded0) ? `<div class="small-muted">まもなく自動で抽選が行われます。</div>` : ""))}
      <div class="small-muted" style="margin-top:6px;">
        開始: ${round.start_at ? fmtDate(round.start_at) : "-"}　
        1次締切: ${round.end_at ? fmtDate(round.end_at) : "-"}　
        2次締切: ${round.second_deadline ? fmtDate(round.second_deadline) : "-"}
        ${round.third_deadline ? `　3次締切: ${fmtDate(round.third_deadline)}` : ""}
      </div>
    </div>`;
  }

  // 宿泊が必要な確定先について、宿泊するかどうかの回答を求める（未回答があると分かりやすいよう、上部に表示）
  const lodgingNeeded = assignments.filter(a => {
    if (!requiresLodging(a.slots)) return false;
    if (!isKuroshioSlot(a.slots)) return true;
    // 黒潮の行でも、希望調査で確定した枠（追加枠）なら宿泊回答が必要
    return !!(window.__myConfirmedKeys && window.__myConfirmedKeys.has(a.slot_id + "_" + a.course_number));
  });
  if (lodgingNeeded.length > 0) {
    const deadline = lodgingSettings && lodgingSettings.deadline;
    const deadlinePassed = deadline && Date.now() > new Date(deadline).getTime();
    html += `<div class="card">
      <b class="panel-heading">宿泊するかどうかの回答</b>
      ${deadline ? `<div class="small-muted" style="margin-top:4px;">回答期限: ${fmtDate(deadline)}${deadlinePassed ? '（期限を過ぎています。至急ご回答ください）' : ''}</div>` : `<div class="small-muted" style="margin-top:4px;">回答期限は未設定です。決まり次第お知らせします。</div>`}
      <table class="slots" style="margin-top:8px;">
        <thead><tr><th>クール</th><th>実習先</th><th>回答</th></tr></thead>
        <tbody>
          ${lodgingNeeded.map(a => `
            <tr>
              <td>${window.COURSE_LABELS[a.course_number-1]}</td>
              <td>${esc(a.slots.facility_name)} ${esc(a.slots.department_name)}</td>
              <td>
                ${a.lodging_choice
                  ? `<span class="lodging-badge-answered">✔ ${a.lodging_choice === 'yes' ? '宿泊する' : '宿泊しない'}</span>
                     <button class="small secondary lodging-change-btn" data-id="${a.id}">変更</button>`
                  : `<span class="lodging-badge-unanswered">未回答</span><br/>
                     <button class="small lodging-btn" data-id="${a.id}" data-choice="yes">宿泊する</button>
                     <button class="small secondary lodging-btn" data-id="${a.id}" data-choice="no">宿泊しない</button>`
                }
              </td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>`;
  }

  // ステータスパネル：6マスを埋める進捗として表示
  const hasExemptAbroad = assignments.some(a => a.count_exempt);
  html += `<div class="card">
    <b class="panel-heading">院内・院外・内科系・外科系（3:3カウント）</b>
    <div class="status-grid" style="margin-top:8px;">
      <div class="status-box ${instCounts.internal>=3?'full':''}"><div class="num">${instCounts.internal}/3</div><div class="label">院内</div></div>
      <div class="status-box ${instCounts.external>=3?'full':''}"><div class="num">${instCounts.external}/3</div><div class="label">院外</div></div>
      <div class="status-box ${catCounts.internal_medicine>=3?'full':''}"><div class="num">${catCounts.internal_medicine}/3</div><div class="label">内科系</div></div>
      <div class="status-box ${catCounts.surgery>=3?'full':''}"><div class="num">${catCounts.surgery}/3</div><div class="label">外科系</div></div>
    </div>
    <hr class="panel-divider" />
    <b class="panel-heading">最低1回は必ず行く組み合わせ</b>
    <div class="combo-status" style="margin-top:8px;">
      ${["IN_N", "IN_G", "EX_N", "EX_G"].map(k => `
        <div class="combo-box ${counts[k] > 0 ? 'done' : ''}">
          <div class="combo-num">${counts[k]}</div>
          <div class="combo-label">${COMBO_LABEL[k]}</div>
        </div>
      `).join("")}
    </div>
    <div class="small-muted" style="margin-top:8px;">確定クール: ${filledCourses.size} / 6　（院内内科・院内外科・院外内科・院外外科を最低1回ずつ、残り2回は「院内内科+院外外科」または「院外内科+院内外科」のどちらかの組み合わせで埋まります）</div>
    ${hasExemptAbroad ? `<div class="notice info" style="margin-top:10px;">留学(内科系/外科系の区分なし)の分は「院外」としてのみカウントされ、内科系/外科系にはカウントされていません。そのため、残りは院内内科・院内外科のどちらでも大丈夫です。</div>` : ""}
  </div>`;

  if (assignments.length > 0) {
    html += `<div class="card"><b>確定済みの実習先</b><table class="slots" style="margin-top:8px;"><thead><tr><th>クール</th><th>区分</th><th>実習先</th></tr></thead><tbody>`;
    for (const a of assignments.slice().sort((x,y)=>x.course_number-y.course_number)) {
      html += `<tr><td>${window.COURSE_LABELS[a.course_number-1]}</td><td>${INSTITUTION_LABEL[a.slots.institution_type]}/${CATEGORY_LABEL[a.slots.category]}</td><td>${esc(a.slots.facility_name)} ${esc(a.slots.department_name)}</td></tr>`;
    }
    html += `</tbody></table></div>`;
  }

  if (allDone) {
    // 全クール確定済みでも、ラウンドの進行状況（他の人の希望状況）は閲覧できるようにする
    html += `<div class="notice confirmed">すべてのクールが確定しました。お疲れ様でした。<br/><span class="small-muted">下の表で、ほかの人の希望状況を引き続き見ることができます（閲覧のみ・選択はできません）。</span></div>`;
  }

  if (noRound) {
    html += `<div class="notice info">現在、募集中のラウンドはありません。事務局からの案内をお待ちください（下の表は閲覧のみです）。</div>`;
  }

  const notStarted = notStarted0 || noRound;
  const firstEnded = firstEnded0;
  const secondEnded = secondEnded0;

  let canEdit = false;
  let myPref = null;
  let attempt = !noRound && round.phase === "second_match" ? 2 : 1;
  let displayAttempt = 1;
  let cancelCountdownTarget = null;

  let statusNotice = "";
  let resultAnimation = "";
  let resultPrefId = null;
  let resultDetailText = "";

  if (allDone) {
    // 全クール確定済み：自分の希望判定は行わず、今動いている回（なければ最後の回）を表示する
    if (!noRound) {
      const basePhase = (round.phase || "").replace("_processing", "");
      displayAttempt = basePhase === "third_match" ? 3
        : basePhase === "second_match" ? 2
        : basePhase === "first_choice" ? 1
        : (round.third_deadline ? 3 : (round.second_deadline ? 2 : 1));
      attempt = displayAttempt;

      // 全クール確定済みの人でも、このラウンドの1次マッチングで確定した枠はキャンセル受付期間中ならキャンセルできる
      if (round.cancel_window_start && round.cancel_window_end) {
        const { data: myFirst } = await sb
          .from("preferences")
          .select("*, slots(facility_name, department_name)")
          .eq("student_id", student.id)
          .eq("round_id", round.id)
          .eq("attempt", 1)
          .eq("status", "confirmed")
          .maybeSingle();
        if (myFirst && !myFirst.cancelled) {
          const cwStart = new Date(round.cancel_window_start).getTime();
          const cwEnd = new Date(round.cancel_window_end).getTime();
          const label = `${window.COURSE_LABELS[myFirst.course_number - 1]}「${esc(myFirst.slots.facility_name)} ${esc(myFirst.slots.department_name)}」`;
          if (Date.now() >= cwStart && Date.now() <= cwEnd) {
            statusNotice += `<div class="card" style="border:2px solid #b3413a;">
              <b style="color:#b3413a;">${label} をキャンセルできます</b>
              <div class="countdown-box" style="background:#fbdede;color:#b3413a;"><span>キャンセル受付終了まで</span> <span id="cancel-countdown-timer">--:--:--</span></div>
              <p class="small-muted" style="margin-top:8px;">このラウンドの1次マッチングで確定した枠です。キャンセルすると、この確定は取り消され、2次マッチングで空いている枠から改めて選び直せます。キャンセルできるのは1ラウンドにつき1回だけで、<b>押すと取り消しはできません。</b></p>
              <button class="secondary" id="cancel-confirmed-btn" data-pref-id="${myFirst.id}" data-course="${myFirst.course_number}">この枠をキャンセルする（取り消し不可）</button>
            </div>`;
            cancelCountdownTarget = round.cancel_window_end;
          } else if (Date.now() < cwStart) {
            statusNotice += `<div class="card">
              <b class="panel-heading">${label} のキャンセル受付開始までのカウントダウン</b>
              <div class="countdown-box"><span>キャンセル受付開始まで</span> <span id="cancel-countdown-timer">--:--:--</span></div>
              <div class="small-muted" style="margin-top:6px;">キャンセル受付は ${fmtDate(round.cancel_window_start)} から ${fmtDate(round.cancel_window_end)} までです。</div>
            </div>`;
            cancelCountdownTarget = round.cancel_window_start;
          }
        }
      }
    }
  } else if (notStarted) {
    if (!noRound) statusNotice = `<div class="notice info">このラウンドはまだ開始していません。開始をお待ちください（下の表は閲覧のみ、選択はまだできません）。</div>`;
  } else {
  const attemptLabel = { 1: "1次", 2: "2次", 3: "3次" };
  const phaseOpenAttempt = (phase) => {
    if (phase === "first_choice") return 1;
    if (phase === "second_match") return 2;
    if (phase === "third_match") return 3;
    return null; // closed や *_processing 中は「今まさに新規提出できる」わけではない
  };
  const openAttempt = phaseOpenAttempt(round.phase);
  const maxOfferedAttempt = round.third_deadline ? 3 : (round.second_deadline ? 2 : 1);

  const prefsByAttempt = {};
  for (const a of [1, 2, 3]) {
    if (a > maxOfferedAttempt && a !== openAttempt) { prefsByAttempt[a] = null; continue; }
    const { data } = await sb
      .from("preferences")
      .select("*, slots(facility_name, department_name, facility_accommodation, accommodation)")
      .eq("student_id", student.id)
      .eq("round_id", round.id)
      .eq("attempt", a)
      .maybeSingle();
    prefsByAttempt[a] = data;
  }

  // 1〜3次を順に見て、この学生の「今の状態」を確定させる
  let finalAttempt = null, finalPref = undefined; // undefined = まだ決まっていない
  for (let a = 1; a <= 3; a++) {
    const p = prefsByAttempt[a];
    if (p) {
      if (p.status === "confirmed" || p.status === "submitted") { finalAttempt = a; finalPref = p; break; }
      // p.status === "lost"
      if (a === maxOfferedAttempt) { finalAttempt = a; finalPref = p; break; } // 用意された最後の回でも落選＝最終結果
      // まだ先の回が用意されている場合は、そちらを見に行く
    } else {
      if (openAttempt === a) { finalAttempt = a; finalPref = null; break; } // 今まさにこの回に参加できる
      if (a >= maxOfferedAttempt) { finalAttempt = a; finalPref = null; break; } // これ以上の回は用意されていない
    }
  }

  attempt = finalAttempt || 1;
  myPref = finalPref === undefined ? null : finalPref;

  if (myPref && myPref.status === "confirmed") {
    canEdit = false;
    const wonLottery = myPref.won_lottery === true;
    const lodgingNote = requiresLodging(myPref.slots) ? "\n\nこの施設は宿泊が必要です。画面上の「宿泊するかどうかの回答」から回答をお願いします。" : "";
    const roundWord = attempt === 1 ? "" : `${attemptLabel[attempt]}希望で`;
    statusNotice = `<div class="notice success">🎉 おめでとうございます！${roundWord}${window.COURSE_LABELS[myPref.course_number-1]}「${esc(myPref.slots.facility_name)} ${esc(myPref.slots.department_name)}」に確定しました。次のラウンドをお待ちください。${lodgingNote ? `<br/><b>${esc(lodgingNote.trim())}</b>` : ""}</div>`;
    resultAnimation = wonLottery ? "win" : "smooth";
    resultPrefId = myPref.id;
    resultDetailText = `${window.COURSE_LABELS[myPref.course_number-1]} ${myPref.slots.facility_name} ${myPref.slots.department_name}${lodgingNote}`;

    // 1次マッチング確定後のキャンセル受付（設定されている時間内のみ、1ラウンド1回だけ）
    if (attempt === 1 && !myPref.cancelled && round.cancel_window_start && round.cancel_window_end) {
      const cwStart = new Date(round.cancel_window_start).getTime();
      const cwEnd = new Date(round.cancel_window_end).getTime();
      if (Date.now() >= cwStart && Date.now() <= cwEnd) {
        statusNotice += `<div class="card" style="border:2px solid #b3413a;">
          <b style="color:#b3413a;">この枠をキャンセルできます</b>
          <div class="countdown-box" style="background:#fbdede;color:#b3413a;"><span>キャンセル受付終了まで</span> <span id="cancel-countdown-timer">--:--:--</span></div>
          <p class="small-muted" style="margin-top:8px;">キャンセルすると、この確定は取り消され、2次マッチングで空いている枠から改めて選び直せます。キャンセルできるのは1ラウンドにつき1回だけで、<b>押すと取り消しはできません。</b></p>
          <button class="secondary" id="cancel-confirmed-btn" data-pref-id="${myPref.id}" data-course="${myPref.course_number}">この枠をキャンセルする（取り消し不可）</button>
        </div>`;
        cancelCountdownTarget = round.cancel_window_end;
      } else if (Date.now() < cwStart) {
        statusNotice += `<div class="card">
          <b class="panel-heading">キャンセル受付開始までのカウントダウン</b>
          <div class="countdown-box"><span>キャンセル受付開始まで</span> <span id="cancel-countdown-timer">--:--:--</span></div>
          <div class="small-muted" style="margin-top:6px;">キャンセル受付は ${fmtDate(round.cancel_window_start)} から ${fmtDate(round.cancel_window_end)} までです。</div>
        </div>`;
        cancelCountdownTarget = round.cancel_window_start;
      }
    }
  } else if (myPref && myPref.status === "lost" && attempt === maxOfferedAttempt && openAttempt !== attempt + 1) {
    // 用意されている最後の回でも外れた＝このラウンドでは最終的に枠を獲得できなかった
    const finalMsg = `${attemptLabel[attempt]}マッチングでも抽選に外れ、このラウンドでは枠を獲得することができませんでした。次のラウンドが始まるまでに学年代表までご連絡いただければ、その枠が空いていれば対応可能です。`;
    statusNotice = `<div class="notice warn">${finalMsg}</div>`;
    resultAnimation = "lose-final";
    resultPrefId = myPref.id;
    resultDetailText = finalMsg;
  } else if (round.phase === "closed" && !openAttempt) {
    statusNotice = `<div class="notice info">このラウンドは終了しました。次のラウンドをお待ちください。</div>`;
  } else if (round.phase === "first_choice" && firstEnded) {
    statusNotice = `<div class="notice info">1次締切時刻を過ぎました。まもなく自動で抽選が行われます。少し時間をおいて再読み込みしてください。</div>`;
  } else if (round.phase === "second_match" && secondEnded) {
    statusNotice = `<div class="notice info">2次締切時刻を過ぎました。まもなく自動で抽選が行われます。少し時間をおいて再読み込みしてください。</div>`;
  } else if (round.phase === "third_match" && round.third_deadline && now > new Date(round.third_deadline)) {
    statusNotice = `<div class="notice info">3次締切時刻を過ぎました。まもなく自動で抽選が行われます。少し時間をおいて再読み込みしてください。</div>`;
  } else if (attempt === 1 && openAttempt === 1) {
    if (!myPref || myPref.status === "submitted") {
      canEdit = true;
      if (myPref) statusNotice = `<div class="notice confirmed">${window.COURSE_LABELS[myPref.course_number-1]}「${esc(myPref.slots.facility_name)} ${esc(myPref.slots.department_name)}」を希望として提出済みです。表をタップすると変更できます。</div>`;
    } else if (myPref.status === "lost") {
      statusNotice = `<div class="notice warn">1次マッチングに外れました。2次マッチングに進んでください。</div>`;
      resultAnimation = "lose";
      resultPrefId = myPref.id;
      resultDetailText = "1次マッチングに外れました。2次マッチングに進んでください。";
    }
  } else if (openAttempt && attempt === openAttempt) {
    // 2次・3次マッチングが今まさに進行中（確定/落選前）
    if (!myPref) {
      canEdit = true;
      statusNotice = `<div class="notice warn">${attemptLabel[attempt-1]}マッチングに外れました。空いている枠から${attemptLabel[attempt]}希望を選んでください。</div>`;
      const prevPref = prefsByAttempt[attempt - 1];
      if (prevPref && prevPref.status === "lost") {
        resultAnimation = "lose";
        resultPrefId = prevPref.id;
        resultDetailText = `${attemptLabel[attempt-1]}マッチングに外れました。${attemptLabel[attempt]}マッチングに進んでください。`;
      }
    } else if (myPref.status === "submitted") {
      canEdit = true;
      statusNotice = `<div class="notice confirmed">${attemptLabel[attempt]}希望として「${esc(myPref.slots.facility_name)} ${esc(myPref.slots.department_name)}」を提出済みです。表をタップすると変更できます。</div>`;
    }
  }

  // グリッドに表示するのは常に「今まさに動いている回」の希望状況。
  // 1次で確定済みの学生も、2次・3次マッチングが進行中ならその様子を見られるようにする。
  displayAttempt = openAttempt || attempt;
  }
  // キャンペーンラウンド：対象者以外は閲覧のみ
  const campaignIneligible = !!(round && round.eligibility === "ext_surgery_2" && !allDone && !isCampaignEligible(round, counts, instCounts, student));
  if (campaignIneligible) {
    canEdit = false;
    statusNotice = `<div class="notice info">「${esc(roundLabel(round))}」は、<b>院外外科を2つ取っていて、院外が3つ揃っている人</b>だけが参加できるラウンドです。あなたは対象外のため、表は閲覧のみです。次のラウンドをお待ちください。</div>`;
  } else if (round && round.eligibility === "ext_surgery_2" && !allDone && canEdit) {
    statusNotice = `<div class="notice success">🎁 院外外科を2つ取って院外内科を譲ってくれてありがとうございます！このラウンドは対象者だけが参加できる特別ラウンドです。</div>` + statusNotice;
  }

  // 第4希望（2次・3次マッチング含む）：院外がまだ3つ揃っていない人は院外しか選べない
  // 第4希望以降（2次マッチング・キャンペーン・第5・第6希望も含む）：院外がまだ3つ揃っていない人は院外しか選べない
  const roundOrderForExt = round ? (round.display_order ?? round.round_number) : 0;
  const forceExternal = !!(round && roundOrderForExt >= 4 && !allDone && instCounts.external < 3);
  // 院外内科が必要なのに足りていない人は院外内科しか選べない
  //  ・院内外科を2つ取っていて、院外内科が2つに満たない人
  //  ・院外内科をまだ1つも取っていない人
  // 第4希望以降（キャンペーン・第5・第6希望も含む）で適用。院外内科が必要数に達したら自動で外れる
  const roundOrder = round ? (round.display_order ?? round.round_number) : 0;
  // ※第5希望以降は「院外内科しか選べない」制限はかけない（院外縛りのみ）。第4希望（1次・2次）だけの制限
  const forceExtNaika = !!(round && round.round_number === 4 && !allDone
    && ((counts.IN_G === 2 && counts.EX_N < 2) || counts.EX_N === 0));
  window.__forceExternal = forceExternal;
  window.__forceExtNaika = forceExtNaika;
  // 院内・院外がすでに3つ揃っている人は、そちらをもう選べない（留学・黒潮の枠も院内/院外として数える）
  window.__instFull = { internal: instCounts.internal >= 3, external: instCounts.external >= 3 };
  if (forceExtNaika && canEdit) {
    statusNotice += `<div class="notice warn">あなたは<b>院外・内科系の枠しか選べません</b>（院外内科が3:3ルールの必要数に足りていないため）。それ以外の枠はタップできません。</div>`;
  } else if (forceExternal && canEdit) {
    statusNotice += `<div class="notice warn">院外がまだ3つ揃っていない人は<b>院外の枠しか選べません</b>（あなたは院外 ${instCounts.external}/3）。院内の枠はタップできません。</div>`;
  }
  html += statusNotice;

  if (resultAnimation) {
    html += renderResultAnimation(resultAnimation);
  }

  if (!notStarted && feasible.length === 1) {
    const a = feasible[0];
    const target = { IN_N: a, IN_G: 3 - a, EX_N: 3 - a, EX_G: a };
    const remainMsg = ["IN_N","IN_G","EX_N","EX_G"]
      .filter(k => counts[k] < target[k])
      .map(k => COMBO_LABEL[k]);
    if (remainMsg.length > 0) {
      html += `<div class="notice warn">組み合わせの都合上、残りは「${remainMsg.join("・")}」から選ぶ必要があります。</div>`;
    }
  }

  appEl.innerHTML = html;
  attachLodgingHandlers();
  attachCancelHandler(student);
  // 宿泊の回答がまだの人にはポップアップで知らせる（3時間ごと）
  {
    const unanswered = lodgingNeeded.filter(a => !a.lodging_choice);
    if (unanswered.length > 0) maybeShowLodgingPopup(student, unanswered, lodgingSettings);
  }
  if (window.__allRoundsEnded) maybeShowAllEndedPopup(student);
  try { await renderMoveSection(student); } catch (e) { console.error("空き枠トレード欄の表示に失敗しました", e); }
  try { await renderSwapSection(student, assignments); } catch (e) { console.error("トレード欄の表示に失敗しました", e); }
  if (allDone) {
    maybeShowResultReveal("all-done-" + student.id, "alldone", "6クールすべての実習先が決まりました。お疲れ様でした！");
  }
  if (resultAnimation) {
    maybeShowResultReveal(resultPrefId, resultAnimation === "lose-once" ? "lose" : resultAnimation, resultDetailText);
  }
  if (canEdit && forceExtNaika) {
    maybeShowForceExtNaikaPopup(student, round, attempt);
  } else if (canEdit && forceExternal) {
    maybeShowForceExternalPopup(student, round, attempt, instCounts.external);
  }
  // 第4希望：すでに院外外科を2つ取っている人（南さんを除く）にお礼とキャンペーンの案内
  if (round && round.round_number === 4 && !allDone
      && counts.EX_G >= 2
      && !/^南/.test((student.name || "").trim())
      && !isCampaignExcluded(student)) {
    maybeShowCampaignThanksPopup(student, round, attempt, forceExtNaika);
  }
  // 第4希望：院外内科1・院外外科1の人（佐伯さん・谷口さんを除く）に、院外外科を取ればキャンペーンで先行できることを案内
  if (round && round.round_number === 4 && !allDone && !forceExtNaika
      && counts.EX_N === 1 && counts.EX_G === 1
      && comboEligible(counts, "EX_G", feasible)
      && !/^(佐伯|谷口)/.test((student.name || "").trim())) {
    maybeShowCampaignInvitePopup(student, round, attempt);
  }
  // 院外縛りの人には、院外縛りのポップアップだけを出す（院外内科のお願いは出さない）
  if (canEdit && !allDone && !forceExtNaika && !forceExternal) {
    maybeShowExnPopup(student, round, attempt, counts, assignments.some(a => a.count_exempt));
  }
  if (countdownTarget) {
    startCountdown(countdownTarget);
  }
  if (cancelCountdownTarget) {
    startCountdown(cancelCountdownTarget, "cancel-countdown-timer", "まもなく切り替わります…");
  }

  const { data: slots } = await sb.from("slots").select("*").eq("active", true);
  const { data: facilityLimits } = await sb.from("facility_limits").select("*");
  const limitMap = {};
  (facilityLimits || []).forEach(f => { limitMap[f.facility_name] = f; });

  const { data: roundPrefs } = noRound ? { data: [] } : await sb
    .from("preferences")
    .select("slot_id, course_number, paired_course_number, status, reveal_self, student_id, students(attendance_number, name)")
    .eq("round_id", round.id)
    .eq("attempt", displayAttempt)
    .in("status", ["submitted", "lottery", "confirmed"]);

  // どのラウンドで決まった枠か（名前の色と①〜⑥の印に使う）
  window.__decided = {};
  try {
    const [{ data: cPrefs }, { data: allRounds }] = await Promise.all([
      sb.from("preferences").select("student_id, slot_id, course_number, paired_course_number, round_id, attempt").eq("status", "confirmed"),
      sb.from("rounds").select("id, round_number, title, display_order"),
    ]);
    const rById = {};
    (allRounds || []).forEach(r => { rById[r.id] = r; });
    (cPrefs || []).forEach(p => {
      const r = rById[p.round_id];
      if (!r) return;
      const info = { round_number: r.round_number, title: r.title, order: (r.display_order ?? r.round_number), attempt: p.attempt };
      window.__decided[String(p.student_id) + "_" + String(p.slot_id) + "_" + p.course_number] = info;
      if (p.paired_course_number) window.__decided[String(p.student_id) + "_" + String(p.slot_id) + "_" + p.paired_course_number] = info;
    });
  } catch (e) { console.error("決定ラウンドの取得に失敗しました", e); }

  // 受付中の空き枠トレードの申請（表の中に「誰がどこへ申請中か」を出すため）
  window.__moveReqs = [];
  try {
    const { data: openRuns } = await sb.from("move_runs").select("id").eq("status", "open");
    const ids = (openRuns || []).map(r => r.id);
    if (ids.length > 0) {
      const [{ data: mreqs }, { data: mstuds }] = await Promise.all([
        sb.from("move_requests").select("student_id, course_number, to_course, from_slot, to_slot").in("run_id", ids).eq("status", "pending"),
        sb.from("students").select("id, attendance_number, name"),
      ]);
      const nm = {};
      (mstuds || []).forEach(x => { nm[String(x.id)] = x.name; });
      window.__moveReqs = (mreqs || []).map(r => Object.assign({}, r, { name: nm[String(r.student_id)] || "" }));
    }
  } catch (e) { console.error("空き枠トレードの申請の取得に失敗しました", e); }

  const { data: allAssignments } = await sb
    .from("assignments")
    .select("*, students(attendance_number, name)");


  // キャンセルによって空いた枠のお知らせ（今のラウンドで出たものだけ・まだ埋まっていないもの）
  const { data: recentCancellations } = noRound ? { data: [] } : await sb
    .from("preferences")
    .select("course_number, slots(id, facility_name, department_name, cap_1,cap_2,cap_3,cap_4,cap_5,cap_6)")
    .eq("cancelled", true)
    .eq("round_id", round.id);

  const stillOpenCancellations = (recentCancellations || []).filter(p => {
    const cap = p.slots["cap_" + p.course_number];
    const used = allAssignments.filter(a => a.slot_id === p.slots.id && a.course_number === p.course_number).length;
    return cap > 0 && used < cap;
  });
  if (stillOpenCancellations.length > 0) {
    const seen = new Set();
    const uniqueRows = stillOpenCancellations.filter(p => {
      const key = p.course_number + "_" + p.slots.id;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    appEl.insertAdjacentHTML("afterbegin", `<div class="card" style="border:2px solid #2f6fb3;">
      <b style="color:#2f6fb3;">📣 キャンセルにより空きが出た枠</b>
      <ul style="margin:8px 0 0 18px; padding:0;">
        ${uniqueRows.map(p => `<li>${window.COURSE_LABELS[p.course_number-1]}「${esc(p.slots.facility_name)} ${esc(p.slots.department_name)}」</li>`).join("")}
      </ul>
    </div>`);
  }

  const facilityCourseCount = {};
  const facilityConfirmedCount = {};
  for (const s of slots) {
    if (s.institution_type !== "external") continue;
    for (let c = 1; c <= 6; c++) {
      const confirmedN = allAssignments.filter(a => a.slot_id === s.id && a.course_number === c).length;
      const pendingN = roundPrefs.filter(p => p.slot_id === s.id && (p.course_number === c || p.paired_course_number === c) && p.status !== "confirmed").length;
      const key = s.facility_name + "_" + c;
      facilityCourseCount[key] = (facilityCourseCount[key] || 0) + confirmedN + pendingN;
      facilityConfirmedCount[key] = (facilityConfirmedCount[key] || 0) + confirmedN;
    }
  }

  const globalRevealed = noRound || !round.reveal_at || now >= new Date(round.reveal_at);

  // 詰み判定：3:3ルールを満たせる空き枠が全く残っていない人にはお知らせを出す
  if (!allDone) {
    const lim = {};
    Object.keys(limitMap).forEach(k => { lim[k] = limitMap[k].max_total; });
    const avail = buildStuckAvailability(slots || [], allAssignments || [], lim, s => quotaAllows(s, window.__myQuota));
    const mine = applyPlannedSwap(student, assignments).map(a => ({
      course_number: a.course_number, count_exempt: a.count_exempt,
      institution_type: a.slots.institution_type, category: a.slots.category,
    }));
    if (isStudentStuck(mine, avail)) {
      appEl.insertAdjacentHTML("afterbegin", `<div class="notice warn" style="border:2px solid #b3413a;"><b>現在、3:3のルールを満たせる空き枠が残っていません。</b><br/>全ラウンドが終わった後に個別に対応しますので、しばらくお待ちください。</div>`);
      maybeShowStuckPopup(student, round);
    }
  }

  if (!noRound) {
    const votedCount = new Set((roundPrefs || []).map(p => p.student_id)).size;

    const { data: allStudents } = await sb.from("students").select("id, name, attendance_number");
    const { data: myAssignCounts } = await sb.from("assignments").select("student_id, slot_id, count_exempt");
    const cnt = {};
    (myAssignCounts || []).forEach(a => { cnt[a.student_id] = (cnt[a.student_id] || 0) + 1; });
    // 対象者の集合（まだ6クール揃っていない人）。キャンペーンは条件で絞る
    let targetSet = new Set((allStudents || []).filter(s => (cnt[s.id] || 0) < 6).map(s => s.id));
    if (round.eligibility === "ext_surgery_2") {
      // キャンペーン：院外外科2つ・院外3つの人だけが対象
      const slotInfo = {};
      (slots || []).forEach(s => { slotInfo[s.id] = s; });
      const exG = {}, ext = {};
      (myAssignCounts || []).forEach(a => {
        const s = slotInfo[a.slot_id];
        if (!s || s.institution_type !== "external") return;
        ext[a.student_id] = (ext[a.student_id] || 0) + 1;
        if (s.category === "surgery" && !a.count_exempt) exG[a.student_id] = (exG[a.student_id] || 0) + 1;
      });
      targetSet = new Set((allStudents || []).filter(s => (cnt[s.id] || 0) < 6 && (exG[s.id] || 0) >= 2 && (ext[s.id] || 0) >= 3 && !isCampaignExcluded(s)).map(s => s.id));
    }

    // 2次・3次では、前の回で確定した人を対象から外す。
    // ※以前は「6クール揃った人」と「前の回で確定した人」を別々に引いていたため、
    //   この回で6クール目が決まった人を二重に引いてしまい、対象人数が少なく表示されていた。
    //   集合で管理して、同じ人を二重に引かないようにする。
    //   落選した人だけでなく、投票し忘れた人・キャンセルした人も自動的に対象人数に残る。
    for (let a = 1; a < displayAttempt; a++) {
      const { data: confirmedAtA } = await sb
        .from("preferences")
        .select("student_id")
        .eq("round_id", round.id)
        .eq("attempt", a)
        .eq("status", "confirmed");
      (confirmedAtA || []).forEach(p => targetSet.delete(p.student_id));
    }
    const targetCount = targetSet.size;

    const attemptWord = displayAttempt === 1 ? "1次" : displayAttempt === 2 ? "2次" : "3次";
    // ラウンドが終わっている（全ラウンド終了を含む）ときは、提出人数の欄は出さない
    if (!window.__allRoundsEnded && round.phase !== "closed") {
      appEl.insertAdjacentHTML("beforeend", `<div class="card"><b>${votedCount}/${targetCount}人</b><span class="small-muted"> が${attemptWord}マッチングの対象者のうち、すでに希望を提出しています。</span></div>`);
    }
  }

  renderLegend(globalRevealed);
  renderFullGrid("internal", "院内", slots, roundPrefs || [], allAssignments || [], student, round, attempt, myPref, canEdit, counts, feasible, globalRevealed, limitMap, facilityCourseCount, facilityConfirmedCount, filledCourses);
  renderFullGrid("external", "院外", slots, roundPrefs || [], allAssignments || [], student, round, attempt, myPref, canEdit, counts, feasible, globalRevealed, limitMap, facilityCourseCount, facilityConfirmedCount, filledCourses);
}

function renderLegend(globalRevealed) {
  appEl.insertAdjacentHTML("beforeend", `
    <div class="card">
      <div class="legend">
        <span><span class="sw" style="background:#fff2a8;border:1px solid #d8c463;"></span>内科系</span>
        <span><span class="sw" style="background:#b9e6b5;border:1px solid #7fc27a;"></span>外科系</span>
        <span><span class="sw" style="background:#fff;border:2px solid #2f6fb3;"></span>枠に空きあり</span>
        <span><span class="sw" style="background:#fff;border:2px solid #d99a3a;"></span>ちょうど定員</span>
        <span><span class="sw" style="background:#fff;border:2px solid #b3413a;"></span>定員超過中(それでも選択可)</span>
        <span><span class="sw" style="background:#dcdcdc;"></span>受入不可/満員(確定)/対象者限定</span>
        <span><span class="sw" style="background:#ede4f7;"></span>あなたの希望</span>
      </div>
      <p class="small-muted">枠の縁の色は希望者数の状況（青=空きあり、オレンジ=ちょうど定員、赤=超過）を常に表示します。すでに確定人数だけで満員になった枠は、他の未確定枠と区別しやすいようグレー表示にしています。院外の表は、同じ病院ごとに太線で区切っています。施設名をタップすると、宿泊・集合時間・連絡事項の詳細が見られます。定員を超えていても締切までは希望を出せ、締切後に自動で抽選されます。宿泊が絡む施設は最初から氏名が表示されます。宿泊が絡まない施設は、抽選で確定するまで氏名は表示されません（人数のみ）。確定者の名前の前の①〜⑥は、何番目の希望（ラウンド）で決まったかです（🎁はキャンペーン、「2次」は2次マッチング）。名前の色もラウンドごとに分けていて（①赤・②オレンジ・③黄土・④緑・⑤青・⑥紫・🎁青緑）、宿泊ありの枠の宿泊の回答は名前の後ろの「(宿泊する)」などで表示しています。同じ枠の中では早く決まった人から順に並んでいます。印がない人は黒潮・個別登録などです。🔄付きの黒字はトレード・空き枠トレードで入れ替わった枠です。水色の「🔁空き枠トレード申請中」はその枠への移動を申請中の人、「（移動申請中）」はその枠からほかの枠への移動を申請中の人です。③クールの院内外科の「うち必須◯名」は、希望者のうち、③クールで院内外科を取らないと3:3のルールで6クールを揃えられなくなる人の人数です（誰かは表示されません）。</p>
    </div>
  `);
}

function isStudyAbroadFacility(facilityName) {
  return facilityName.startsWith("留学(") || facilityName.startsWith("留学（");
}

function renderFullGrid(institutionType, label, slots, roundPrefs, allAssignments, student, round, attempt, myPref, canEdit, counts, feasible, globalRevealed, limitMap, facilityCourseCount, facilityConfirmedCount, filledCourses) {
  const rawList = slots
    .filter(s => s.institution_type === institutionType)
    .sort((a, b) => a.sort_order - b.sort_order);

  if (rawList.length === 0) return;

  // 留学枠は大学ごとに1行へ統合（内科/外科の区別を表示上つけない）
  const displayRows = [];
  const abroadIndex = {};
  for (const s of rawList) {
    if (isStudyAbroadFacility(s.facility_name)) {
      if (abroadIndex[s.facility_name] === undefined) {
        abroadIndex[s.facility_name] = displayRows.length;
        displayRows.push({ facility_name: s.facility_name, department_name: "", isAbroad: true, slotIds: [s.id], category: null, sortOrder: s.sort_order });
      } else {
        displayRows[abroadIndex[s.facility_name]].slotIds.push(s.id);
      }
    } else {
      displayRows.push({ facility_name: s.facility_name, department_name: s.department_name, isAbroad: false, slot: s, sortOrder: s.sort_order });
    }
  }
  displayRows.sort((a, b) => a.sortOrder - b.sortOrder);

  let rows = "";
  let prevFacility = null;
  for (const row of displayRows) {
    const facilityChanged = institutionType === "external" && row.facility_name !== prevFacility;
    prevFacility = row.facility_name;

    if (row.isAbroad) {
      rows += `<tr class="row-abroad ${facilityChanged ? 'facility-start' : ''}"><td class="dept-col"><b class="facility-name">${esc(row.facility_name)}</b><br/><span class="small-muted">留学（確定済み）</span></td>`;
      for (let c = 1; c <= 6; c++) {
        const names = allAssignments
          .filter(a => row.slotIds.includes(a.slot_id) && a.course_number === c)
          .map(a => `<b>${esc(a.students.name)}</b>`).join("<br>");
        rows += `<td class="cell-slot cell-blocked">${names ? `<div class="cell-names">${names}</div>` : ""}</td>`;
      }
      rows += `</tr>`;
      continue;
    }

    const s = row.slot;
    const rowClass = s.category === "internal_medicine" ? "row-naika" : "row-geka";
    const limit = limitMap[s.facility_name];
    const isNanwakayama = s.facility_name.includes("南和歌山医療");
    const limitBadge = limit
      ? `<div class="facility-limit-badge">🛈 施設全体1クールあたり最大${limit.max_total}名まで${isNanwakayama ? '(6名時、男女3:3は自動回避)' : ''}</div>`
      : "";
    const isKuroshioRow = s.department_name.includes("黒潮医療人養成プロジェクト") || s.facility_name.includes("黒潮医療人養成プロジェクト");
    const hasNewCourses = Array.isArray(s.new_courses) && s.new_courses.length > 0;
    const lodgingBadge = ((!isKuroshioRow || hasNewCourses) && requiresLodging(s)) ? `<div class="lodging-badge">🏨 宿泊あり：氏名を最初から表示</div>` : "";
    const dormBadge = s.facility_name.includes("南和歌山医療") ? `<div class="lodging-badge">🏨 宿舎:1人部屋2室+4人部屋1室(計6人まで／病院全体の人数上限ではありません)</div>` : "";
    const pairingBadge = s.department_name.includes("病理診断") ? `<div class="pairing-badge">🔗 2ターム連続で取る必要があります</div>` : "";
    rows += `<tr class="${rowClass} ${facilityChanged ? 'facility-start' : ''}"><td class="dept-col facility-tap" data-facility="${esc(s.facility_name)}"><b class="facility-name">${esc(s.facility_name)}</b><br/>${esc(s.department_name)}${limitBadge}${lodgingBadge}${dormBadge}${pairingBadge}</td>`;
    for (let c = 1; c <= 6; c++) {
      rows += renderCell(s, c, roundPrefs, allAssignments, student, round, attempt, myPref, canEdit, counts, feasible, globalRevealed, limitMap, facilityCourseCount, facilityConfirmedCount, filledCourses);
    }
    rows += `</tr>`;
  }

  const header = `<tr><th class="dept-col">実習先 / 診療科</th>${window.COURSE_LABELS.map((l,i) => `<th>${l}<br/><span class="course-date">${window.COURSE_DATES[i]}</span></th>`).join("")}</tr>`;

  appEl.insertAdjacentHTML("beforeend", `
    <div class="card">
      <b>${label}の実習先</b>
      ${institutionType === "external" ? `` : ""}
      <div class="grid-scroll" style="margin-top:8px;">
        <table class="pref-grid">
          <thead>${header}</thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>
  `);

  document.querySelectorAll(`td.cell-open[data-institution="${institutionType}"]`).forEach(td => {
    td.addEventListener("click", () => onCellClick(td, student, round, attempt, myPref));
  });

  document.querySelectorAll(`td.facility-tap`).forEach(td => {
    td.addEventListener("click", () => {
      const fname = td.dataset.facility;
      const slot = rawList.find(s => s.facility_name === fname);
      if (!slot) return;
      const limit = limitMap[fname];
      openFacilityModal({
        facility_name: fname,
        accommodation: slot.facility_accommodation || slot.accommodation,
        gather_time: slot.facility_gather_time || slot.gather_time,
        note: slot.facility_note || slot.note,
        limit_note: limit ? `${limit.note}（1クールあたり施設全体で最大${limit.max_total}名）` : "",
      });
    });
  });
}

function renderCell(slot, courseNumber, roundPrefs, allAssignments, student, round, attempt, myPref, canEdit, counts, feasible, globalRevealed, limitMap, facilityCourseCount, facilityConfirmedCount, filledCourses) {
  const cap = slot["cap_" + courseNumber];
  const isKuroshio = slot.department_name.includes("黒潮医療人養成プロジェクト") || slot.facility_name.includes("黒潮医療人養成プロジェクト");

  if (cap <= 0) {
    return `<td class="cell-slot cell-blocked">×</td>`;
  }
  // 後から追加された枠（slots.new_courses に入っているクール）には NEW マークを付ける
  const isNewSlot = Array.isArray(slot.new_courses) && slot.new_courses.map(Number).includes(courseNumber);
  const newBadge = isNewSlot
    ? `<div><span style="display:inline-block;font-size:0.55rem;font-weight:800;color:#fff;background:#e0443a;padding:0 5px;border-radius:999px;line-height:1.5;letter-spacing:0.05em;">NEW</span></div>`
    : "";

  // 黒潮の行は基本選択不可。ただし追加枠(NEW)があるクールだけは一般の学生も選べる
  if (isKuroshio && !isNewSlot) {
    const kuroshioConfirmed = allAssignments.filter(a => a.slot_id === slot.id && a.course_number === courseNumber);
    const kuroshioNames = kuroshioConfirmed.map(a => `<b>${esc(a.students.name)}</b>`).join("<br>");
    return `<td class="cell-slot cell-blocked">
      ${kuroshioNames ? `<div class="cell-names">${kuroshioNames}</div>` : ""}
    </td>`;
  }

  const confirmedHere = allAssignments.filter(a => a.slot_id === slot.id && a.course_number === courseNumber);
  // 全クール確定済みの学生は「閲覧専用」：全列をグレーアウトせず、通常の見た目で表示する
  const viewOnlyAllDone = filledCourses.size >= 6;
  const isMyOwnFilledCourse = !viewOnlyAllDone && filledCourses.has(courseNumber);

  const isMine = !!(myPref && myPref.slot_id === slot.id &&
    (myPref.course_number === courseNumber || myPref.paired_course_number === courseNumber) &&
    (myPref.status === "submitted" || myPref.status === "lottery"));
  const pendingHere = roundPrefs.filter(p => p.slot_id === slot.id &&
    (p.course_number === courseNumber || p.paired_course_number === courseNumber) &&
    p.status !== "confirmed");
  const totalCount = confirmedHere.length + pendingHere.length;
  const confirmedFull = confirmedHere.length >= cap;

  const facilityLimit = limitMap[slot.facility_name];
  const facKey = slot.facility_name + "_" + courseNumber;
  const facCount = facilityCourseCount[facKey] || 0;
  const facilityConfirmedFull = facilityLimit && (facilityConfirmedCount[facKey] || 0) >= facilityLimit.max_total;

  // 枠の色（縁取り）は「今のラウンドで実際に希望している人」がいるかどうかだけで判定する。
  // 既に他ラウンドで確定済みの人数だけで空きがあるように見えても、それだけでは色をつけない。
  const remainingCap = cap - confirmedHere.length;
  const isExactFull = pendingHere.length > 0 && pendingHere.length === Math.max(remainingCap, 0);
  const isOverFull = pendingHere.length > Math.max(remainingCap, 0);
  const facilityExact = facilityLimit && pendingHere.length > 0 && facCount === facilityLimit.max_total;
  const facilityOver = facilityLimit && facCount > facilityLimit.max_total && pendingHere.length > 0;

  const lodging = requiresLodging(slot);

  function lodgingTag(a) {
    if (!lodging || isKuroshio) return "";
    if (a.lodging_choice === "yes") return ` <span class="lodge-tag lodge-yes">(宿泊する)</span>`;
    if (a.lodging_choice === "no") return ` <span class="lodge-tag lodge-no">(宿泊しない)</span>`;
    return ` <span class="lodge-tag lodge-unanswered">(未回答)</span>`;
  }

  // トレード（交換）で入れ替わった枠は紫色＋🔄で表示する
  // トレード・空き枠移動で入れ替わった枠は黒字＋🔄で表示する
  const swapMark = a => a.swapped ? `<span style="color:#000;font-weight:800;">🔄</span>` : "";
  const swapStyle = a => a.swapped ? ` style="color:#000;"` : "";
  // 何ラウンドで決まったか：①〜⑥（キャンペーンは🎁）の印と、名前の色で表示。早く決まった人から順に並べる
  const decidedOf = a => (window.__decided || {})[String(a.student_id) + "_" + String(a.slot_id) + "_" + courseNumber];
  const ROUND_COLOR = { 1: "#c62828", 2: "#e67e00", 3: "#9a7d00", 4: "#2e7d32", 5: "#1565c0", 6: "#6a1b9a" };
  const roundMark = d => {
    if (!d) return "";
    const color = d.title ? "#00838f" : (ROUND_COLOR[d.round_number] || "#555");
    const mark = d.title ? "🎁" : (["", "①", "②", "③", "④", "⑤", "⑥"][d.round_number] || d.round_number);
    return `<span style="color:${color};font-weight:800;">${mark}${d.attempt === 2 ? "<small>2次</small>" : ""}</span>`;
  };
  const roundNameStyle = d => {
    if (!d) return ""; // 宿泊ありの枠も名前はラウンドの色（宿泊の回答は後ろの「(宿泊する)」などで分かる）
    const color = d.title ? "#00838f" : (ROUND_COLOR[d.round_number] || "");
    return color ? ` style="color:${color};"` : "";
  };
  const sortedConfirmed = confirmedHere.slice().sort((x, y) => {
    const dx = decidedOf(x), dy = decidedOf(y);
    const ox = dx ? dx.order * 10 + (dx.attempt || 1) : 9999;
    const oy = dy ? dy.order * 10 + (dy.attempt || 1) : 9999;
    return ox - oy;
  });
  const moveReqs = window.__moveReqs || [];
  const movingOut = a => moveReqs.some(r => String(r.student_id) === String(a.student_id)
    && String(r.from_slot) === String(slot.id) && Number(r.course_number) === courseNumber);
  const outTag = a => movingOut(a) ? `<span style="color:#2fa3c9;font-size:0.58rem;font-weight:700;">（移動申請中）</span>` : "";
  const movingIn = moveReqs.filter(r => String(r.to_slot) === String(slot.id) && Number(r.to_course || r.course_number) === courseNumber);
  const movingInHtml = movingIn.length
    ? `<div style="color:#2fa3c9;font-size:0.6rem;font-weight:700;line-height:1.25;margin-top:2px;">🔁空き枠トレード申請中：<br>${movingIn.map(r => esc(r.name)).join("<br>")}</div>`
    : "";
  const confirmedNamesHtml = sortedConfirmed.map(a => {
    const d = decidedOf(a);
    return a.students.attendance_number === student.attendance_number
      ? `<span class="me-confirmed"${swapStyle(a)}>✔ ${swapMark(a)}${roundMark(d)}${esc(a.students.name)}(あなた)</span>${lodgingTag(a)}${outTag(a)}`
      : `<b class="${lodging ? (a.lodging_choice === 'yes' ? 'name-lodging-yes' : a.lodging_choice === 'no' ? 'name-lodging-no' : 'name-lodging-unanswered') : ''}"${a.swapped ? swapStyle(a) : roundNameStyle(d)}>${swapMark(a)}${roundMark(d)}${esc(a.students.name)}</b>${lodgingTag(a)}${outTag(a)}`;
  }).join("<br>") + movingInHtml;

  // 匿名ルール：
  // ・宿泊が絡む施設 → 最初から全員に氏名を表示（部屋割り調整のため）。
  // ・宿泊が絡まない施設 → 抽選確定(confirmed)するまでは氏名を出さない（自分自身の分を除く）。
  // ③クールの院内外科だけ、希望者のうち「必須」の人数を表示する（誰が必須かは表示しない）
  // 必須＝③クールで院内外科を取らないと6クールを揃えられない人：
  //   岩崎さん(7)・大塚さん(13)・髙木さん(40)・馬場谷さん(61)・檜皮谷さん(67)・吉田泰規さん(98)
  const MUST_IN_G_COURSE3 = [7, 13, 40, 61, 67, 98];
  const isC3InternalSurgery = courseNumber === 3 && slot.institution_type === "internal" && slot.category === "surgery";
  const mustCount = isC3InternalSurgery
    ? pendingHere.filter(p => p.students && MUST_IN_G_COURSE3.includes(Number(p.students.attendance_number))).length
    : 0;
  const mustLine = mustCount > 0
    ? `<span style="color:#b3413a;font-weight:700;">うち必須 ${mustCount}名</span>`
    : "";
  let pendingNamesHtml = "";
  if (lodging) {
    pendingNamesHtml = pendingHere.map(p =>
      p.student_id === student.id ? `<b>あなた（${esc(p.students.name)}）</b>` : esc(p.students.name)
    ).concat(mustLine ? [mustLine] : []).join("<br>");
  } else {
    const shown = [];
    let hiddenCount = 0;
    for (const p of pendingHere) {
      if (p.student_id === student.id) shown.push(`<b>あなた</b>`);
      else hiddenCount++;
    }
    if (hiddenCount > 0) shown.push(`${hiddenCount}名希望中`);
    if (mustLine) shown.push(mustLine);
    pendingNamesHtml = shown.join("<br>");
  }
  const namesHtml = [confirmedNamesHtml, pendingNamesHtml].filter(Boolean).join("<br>");

  if (confirmedFull || facilityConfirmedFull) {
    const label = confirmedFull ? "満員(確定)" : "施設全体満員(確定)";
    return `<td class="cell-slot cell-other-term">
      ${newBadge}
      <div class="cell-cap">${totalCount}/${cap}</div>
      <div class="cell-names">${label}</div>
      ${confirmedNamesHtml ? `<div class="cell-names">${confirmedNamesHtml}</div>` : ""}
    </td>`;
  }

  const combo = comboKeyOf(slot);
  // 自分がこのクールを既に確定している場合は、他の情報は見えるが選択操作だけできないようにする
  let eligible = !isMyOwnFilledCourse && canEdit && comboEligible(counts, combo, feasible)
    && quotaAllows(slot, window.__myQuota)
    && !(window.__instFull && window.__instFull[slot.institution_type])
    && (!window.__forceExternal || slot.institution_type === "external")
    && (!window.__forceExtNaika || (slot.institution_type === "external" && slot.category === "internal_medicine"));

  let cls = "cell-slot";
  if (viewOnlyAllDone) { /* 閲覧専用：色は変えない */ }
  else if (isMyOwnFilledCourse) cls += " cell-other-term";
  else if (eligible) cls += " cell-open";
  else cls += " cell-ineligible";

  // 枠(ボーダー)の色は「今のラウンドで実際に希望している人」がいる場合だけ表示する：
  // 空きあり=青、ちょうど定員=オレンジ、超過=赤
  if (pendingHere.length > 0) {
    if (isOverFull || facilityOver) cls += " frame-over";
    else if (isExactFull || facilityExact) cls += " frame-exact";
    else cls += " frame-under";
  }

  // 背景は基本そのままの科目色。自分が選んだものだけ紫背景にする
  if (isMine) cls += " cell-mine";

  const requiresPairing = slot.department_name.includes("病理診断");

  const dataAttrs = eligible
    ? `data-slot="${slot.id}" data-course="${courseNumber}" data-institution="${slot.institution_type}" data-category="${slot.category}" data-facility="${esc(slot.facility_name)}" data-dept="${esc(slot.department_name)}" ${requiresPairing ? 'data-pairing="1"' : ''}`
    : "";

  let overNote = "";
  if (pendingHere.length > 0 && (isOverFull || facilityOver)) overNote = `<div class="cell-names" style="color:#b3413a;">定員超過中</div>`;

  return `<td class="${cls}" ${dataAttrs}>
    ${newBadge}
    <div class="cell-cap">${totalCount}/${cap}</div>
    ${namesHtml ? `<div class="cell-names">${namesHtml}</div>` : ""}
    ${overNote}
  </td>`;
}

function openChoiceModal(title, message, options) {
  // options: [{label, value}]。ボタンを押すとPromiseがそのvalueでresolveする。閉じた場合はnullでresolveする。
  return new Promise((resolve) => {
    ensureModalRoot();
    const root = document.getElementById("facility-modal-root");
    root.innerHTML = `
      <div class="modal-backdrop" id="choice-backdrop">
        <div class="modal-box">
          <b>${esc(title)}</b>
          <p style="margin-top:8px;">${esc(message)}</p>
          <div style="display:flex; flex-direction:column; gap:8px; margin-top:12px;">
            ${options.map((o, i) => `<button class="choice-btn" data-i="${i}">${esc(o.label)}</button>`).join("")}
          </div>
          <button class="secondary" id="choice-cancel-btn" style="margin-top:10px;">キャンセル</button>
        </div>
      </div>
    `;
    const cleanup = (value) => { closeFacilityModal(); resolve(value); };
    root.querySelectorAll(".choice-btn").forEach(btn => {
      btn.onclick = () => cleanup(options[Number(btn.dataset.i)].value);
    });
    document.getElementById("choice-cancel-btn").onclick = () => cleanup(null);
    document.getElementById("choice-backdrop").addEventListener("click", (e) => {
      if (e.target.id === "choice-backdrop") cleanup(null);
    });
  });
}

async function onCellClick(td, student, round, attempt, myPref) {
  const slotId = td.dataset.slot;
  const courseNumber = Number(td.dataset.course);
  const facility = td.dataset.facility;
  const dept = td.dataset.dept;
  const courseLabel = window.COURSE_LABELS[courseNumber - 1];
  const requiresPairing = td.dataset.pairing === "1";

  let pairedCourseNumber = null;
  if (requiresPairing) {
    const prevCourse = courseNumber - 1;
    const nextCourse = courseNumber + 1;
    const options = [];
    if (prevCourse >= 1) options.push({ label: `${window.COURSE_LABELS[prevCourse-1]}と組み合わせる`, value: prevCourse });
    if (nextCourse <= 6) options.push({ label: `${window.COURSE_LABELS[nextCourse-1]}と組み合わせる`, value: nextCourse });
    if (options.length === 0) {
      alert("この科は2クール連続での履修が必要ですが、前後どちらのクールも選べません。");
      return;
    }
    pairedCourseNumber = await openChoiceModal(
      "2クール連続での履修が必要です",
      `${courseLabel}「${facility} ${dept}」は2クール連続で履修する必要があります。もう一方のクールを選んでください。`,
      options
    );
    if (pairedCourseNumber === null) return; // キャンセルされた

    // 2クール分まとめて追加しても、院内3・院外3・内科3・外科3のルールを超えないか確認する
    const institutionType = td.dataset.institution;
    const category = td.dataset.category;
    const { data: currentAssignments } = await sb
      .from("assignments")
      .select("course_number, count_exempt, slots(institution_type, category)")
      .eq("student_id", student.id)
      .not("course_number", "in", `(${courseNumber},${pairedCourseNumber})`);
    const instCounts = { internal: 0, external: 0 };
    const catCounts = { internal_medicine: 0, surgery: 0 };
    (currentAssignments || []).forEach(a => {
      instCounts[a.slots.institution_type]++;
      if (!a.count_exempt) catCounts[a.slots.category]++;
    });
    if (instCounts[institutionType] + 2 > 3 || catCounts[category] + 2 > 3) {
      alert(`この2クールをまとめて選ぶと、院内3・院外3・内科3・外科3のルールを超えてしまうため選択できません。（現在の${INSTITUTION_LABEL[institutionType]}: ${instCounts[institutionType]}/3、${CATEGORY_LABEL[category]}: ${catCounts[category]}/3 のところに2クール追加しようとしています）`);
      return;
    }
  }

  const ok = confirm(requiresPairing
    ? `${courseLabel}と${window.COURSE_LABELS[pairedCourseNumber-1]}の2クール連続で「${facility} ${dept}」を希望として提出します。両方に空きがない場合は成立しません。よろしいですか？`
    : `${courseLabel}「${facility} ${dept}」を希望として提出します。よろしいですか？`);
  if (!ok) return;

  td.style.opacity = "0.5";

  if (myPref) {
    const { error } = await sb.from("preferences")
      .update({ slot_id: slotId, course_number: courseNumber, paired_course_number: pairedCourseNumber, status: "submitted" })
      .eq("id", myPref.id);
    if (error) { alert("送信に失敗しました: " + error.message); td.style.opacity = "1"; return; }
  } else {
    const { error } = await sb.from("preferences").insert({
      student_id: student.id,
      round_id: round.id,
      slot_id: slotId,
      course_number: courseNumber,
      paired_course_number: pairedCourseNumber,
      attempt: attempt,
      status: "submitted",
    });
    if (error) { alert("送信に失敗しました: " + error.message); td.style.opacity = "1"; return; }
  }
  location.reload();
}

main();


// ============================================================
// 友達同士のトレード（交換）
// ・同じクール番号どうしの枠を入れ替える（1クールだけでも、複数クールまとめてでもOK）
// ・入れ替えた後に、2人とも3:3ルール（院内3・院外3・内科3・外科3、4つの組み合わせ）を満たしていればOK
// ・申請 → 相手が承認（＝相手も同じ内容で申請）した時点で交換成立
// ・黒潮プロジェクトの枠・留学（カウント対象外）の枠は交換できない
// ・管理画面の「トレード」で「トレードを有効にする」がオンで、期間内のときだけ表示する
// ============================================================
function swapComboKey(slot) {
  return (slot.institution_type === "internal" ? "IN" : "EX") + "_" + (slot.category === "internal_medicine" ? "N" : "G");
}
// 枠のリストが3:3ルールに合っているか（6クール揃っていれば最終形、未完成なら「まだ成立しうるか」）
function swapRuleOk(list) {
  const keys = ["IN_N", "IN_G", "EX_N", "EX_G"];
  const c = { IN_N: 0, IN_G: 0, EX_N: 0, EX_G: 0 };
  let inN = 0, exN = 0;
  list.forEach(a => {
    if (a.slots.institution_type === "internal") inN++; else exN++;
    if (!a.count_exempt) c[swapComboKey(a.slots)]++;
  });
  if (inN > 3 || exN > 3) return false;
  const fits = [1, 2].some(x => { const t = { IN_N: x, IN_G: 3 - x, EX_N: 3 - x, EX_G: x }; return keys.every(k => c[k] <= t[k]); });
  if (!fits) return false;
  if (list.length >= 6) return inN === 3 && exN === 3 && keys.every(k => c[k] >= 1);
  return true;
}
function swapBlockedReason(a) {
  if (!a) return "枠がありません";
  if (a.count_exempt) return "留学（カウント対象外）の枠は交換できません";
  const dep = (a.slots.department_name || "") + (a.slots.facility_name || "");
  if (dep.includes("黒潮医療人養成プロジェクト")) return "黒潮プロジェクトの枠は交換できません";
  return null;
}
// 交換してよいかの判定。OKなら null、ダメなら理由の文字列
function validateSwap(mine, theirs, courses, myQuota, theirQuota) {
  if (!courses || courses.length === 0) return "交換するクールを選んでください。";
  for (const c of courses) {
    const a = mine.find(x => x.course_number === c), b = theirs.find(x => x.course_number === c);
    if (!a || !b) return `${window.COURSE_LABELS[c - 1]}はどちらかがまだ確定していないので交換できません。`;
    const r1 = swapBlockedReason(a), r2 = swapBlockedReason(b);
    if (r1) return `${window.COURSE_LABELS[c - 1]}：${r1}`;
    if (r2) return `${window.COURSE_LABELS[c - 1]}：${r2}`;
    if (a.slot_id === b.slot_id) return `${window.COURSE_LABELS[c - 1]}は同じ枠なので交換の意味がありません。`;
    if (!quotaAllows(b.slots, myQuota)) return `${window.COURSE_LABELS[c - 1]}：相手の枠はあなたが選べない枠（一般枠／地・県枠）です。`;
    if (!quotaAllows(a.slots, theirQuota)) return `${window.COURSE_LABELS[c - 1]}：あなたの枠は相手が選べない枠（一般枠／地・県枠）です。`;
  }
  const newMine = mine.map(a => courses.includes(a.course_number) ? Object.assign({}, a, { slots: theirs.find(x => x.course_number === a.course_number).slots }) : a);
  const newTheirs = theirs.map(b => courses.includes(b.course_number) ? Object.assign({}, b, { slots: mine.find(x => x.course_number === b.course_number).slots }) : b);
  if (!swapRuleOk(newMine)) return "この交換をすると、あなたの3:3ルールが崩れてしまいます。";
  if (!swapRuleOk(newTheirs)) return "この交換をすると、相手の3:3ルールが崩れてしまいます。";
  return null;
}
async function loadSwapAssigns(studentId) {
  const { data } = await sb.from("assignments")
    .select("id, course_number, slot_id, count_exempt, slots(facility_name, department_name, institution_type, category)")
    .eq("student_id", studentId);
  return data || [];
}
function swapSlotLabel(a) {
  if (!a) return "（未確定）";
  const k = swapComboKey(a.slots);
  const kl = { IN_N: "院内内", IN_G: "院内外", EX_N: "院外内", EX_G: "院外外" }[k];
  return `[${kl}] ${a.slots.facility_name} ${a.slots.department_name}`;
}

// 交換を実行する（承認した側のブラウザで実行）
async function executeSwap(req, studentsById) {
  const aId = req.from_student, bId = req.to_student;
  const courses = (req.courses || []).map(Number);
  const [A, B] = await Promise.all([loadSwapAssigns(aId), loadSwapAssigns(bId)]);
  const qa = studentsById[aId] ? studentsById[aId].kuroshio_quota : null;
  const qb = studentsById[bId] ? studentsById[bId].kuroshio_quota : null;
  const err = validateSwap(A, B, courses, qa || null, qb || null);
  if (err) return "交換できませんでした：" + err;
  const detail = []; // 元に戻すときのために、交換前の枠を記録しておく
  for (const c of courses) {
    const a = A.find(x => x.course_number === c), b = B.find(x => x.course_number === c);
    const r1 = await sb.from("assignments").update({ slot_id: b.slot_id, lodging_choice: null, swapped: true }).eq("id", a.id);
    const r2 = await sb.from("assignments").update({ slot_id: a.slot_id, lodging_choice: null, swapped: true }).eq("id", b.id);
    if (r1.error || r2.error) return "交換の書き込みに失敗しました。学年代表に連絡してください。" + ((r1.error || r2.error).message || "");
    detail.push({ course: c, from_slot: a.slot_id, to_slot: b.slot_id });
  }
  await sb.from("swap_requests").update({ status: "done", done_at: new Date().toISOString(), detail }).eq("id", req.id);
  // 同じ2人が関わる、ほかの申請中のトレードは古くなるので無効にする
  const { data: others } = await sb.from("swap_requests").select("id, from_student, to_student").eq("status", "pending");
  for (const o of (others || [])) {
    if ([o.from_student, o.to_student].some(x => x === aId || x === bId)) {
      await sb.from("swap_requests").update({ status: "stale" }).eq("id", o.id);
    }
  }
  return null;
}

// 成立したトレードを元に戻す（交換前の枠に入れ替え直す）。OKなら null、ダメなら理由
async function revertSwap(w) {
  if (!Array.isArray(w.detail) || w.detail.length === 0) {
    return "このトレードには交換前の記録がないため、自動では元に戻せません。学年代表に連絡してください。";
  }
  const { data: cur } = await sb.from("assignments")
    .select("id, student_id, course_number, slot_id")
    .in("student_id", [w.from_student, w.to_student]);
  const find = (sid, c) => (cur || []).find(x => String(x.student_id) === String(sid) && x.course_number === Number(c));
  for (const d of w.detail) {
    const a = find(w.from_student, d.course), b = find(w.to_student, d.course);
    if (!a || !b || a.slot_id !== d.to_slot || b.slot_id !== d.from_slot) {
      return `${window.COURSE_LABELS[d.course - 1]}の枠が交換後に変わっているため、自動では元に戻せません。学年代表に連絡してください。`;
    }
  }
  for (const d of w.detail) {
    const a = find(w.from_student, d.course), b = find(w.to_student, d.course);
    const r1 = await sb.from("assignments").update({ slot_id: d.from_slot, lodging_choice: null, swapped: false }).eq("id", a.id);
    const r2 = await sb.from("assignments").update({ slot_id: d.to_slot, lodging_choice: null, swapped: false }).eq("id", b.id);
    if (r1.error || r2.error) return "書き込みに失敗しました: " + (r1.error || r2.error).message;
  }
  await sb.from("swap_requests").update({ status: "reverted" }).eq("id", w.id);
  return null;
}

async function renderSwapSection(student, myAssignsRaw) {
  const { data: ts } = await sb.from("trade_settings").select("*").eq("id", 1).maybeSingle();
  if (!ts || !ts.enabled) return;
  const now = Date.now();
  if (ts.start_at && now < new Date(ts.start_at).getTime()) return;
  if (ts.end_at && now > new Date(ts.end_at).getTime()) return;

  const myId = String(student.id);
  const { data: studs } = await sb.from("students").select("id, attendance_number, name, kuroshio_quota").order("attendance_number");
  const studentsById = {};
  (studs || []).forEach(s => { studentsById[String(s.id)] = s; });
  const myQuota = student.kuroshio_quota || null;
  const mine = await loadSwapAssigns(student.id);

  const { data: reqs } = await sb.from("swap_requests").select("*").eq("status", "pending");
  const incoming = (reqs || []).filter(r => r.to_student === myId);
  const outgoing = (reqs || []).filter(r => r.from_student === myId);
  const nameOf = id => studentsById[id] ? `${studentsById[id].attendance_number} ${studentsById[id].name}` : "（不明）";
  // 自分が関わる、成立済みのトレード（2人とも「元に戻す」を押すと元に戻る）
  const { data: doneSwaps } = await sb.from("swap_requests").select("*").eq("status", "done")
    .or(`from_student.eq.${myId},to_student.eq.${myId}`);
  const courseList = cs => (cs || []).map(c => window.COURSE_LABELS[Number(c) - 1]).join("・");

  let incomingHtml = "";
  for (const r of incoming) {
    const theirs = await loadSwapAssigns(r.from_student);
    const rows = (r.courses || []).map(Number).map(c => `
      <tr><td>${window.COURSE_LABELS[c - 1]}</td>
        <td>${esc(swapSlotLabel(mine.find(x => x.course_number === c)))}</td>
        <td>→</td>
        <td><b>${esc(swapSlotLabel(theirs.find(x => x.course_number === c)))}</b></td></tr>`).join("");
    incomingHtml += `<div class="card" style="border:2px solid #7b3fb3;">
      <b>${esc(nameOf(r.from_student))} さんから交換の申請が来ています</b>
      <table class="slots" style="margin-top:8px;"><thead><tr><th>クール</th><th>あなたの枠（渡す）</th><th></th><th>もらう枠</th></tr></thead><tbody>${rows}</tbody></table>
      <div style="margin-top:8px;">
        <button class="small" data-swap-accept="${r.id}">承認して交換する</button>
        <button class="small secondary" data-swap-decline="${r.id}">断る</button>
      </div>
    </div>`;
  }
  const outgoingHtml = outgoing.map(r => `<div class="small-muted" style="margin:4px 0;">
      ${esc(nameOf(r.to_student))} さんへ申請中（${courseList(r.courses)}）
      <button class="small secondary" data-swap-withdraw="${r.id}">取り下げ</button>
    </div>`).join("");

  const revertHtml = (doneSwaps || []).map(w => {
    const iAmFrom = w.from_student === myId;
    const partner = iAmFrom ? w.to_student : w.from_student;
    const mine = iAmFrom ? w.revert_from : w.revert_to;
    const theirs = iAmFrom ? w.revert_to : w.revert_from;
    let stateHtml, btnHtml;
    if (mine && !theirs) {
      stateHtml = `<span class="small-muted">あなたは「元に戻す」を押しました。相手の同意待ちです。</span>`;
      btnHtml = `<button class="small secondary" data-swap-unrevert="${w.id}">取り消す</button>`;
    } else if (!mine && theirs) {
      stateHtml = `<span style="color:#b3413a;font-weight:700;">相手から「元に戻したい」と依頼が来ています。</span>`;
      btnHtml = `<button class="small" data-swap-revert="${w.id}">同意して元に戻す</button>`;
    } else {
      stateHtml = "";
      btnHtml = `<button class="small secondary" data-swap-revert="${w.id}">元に戻す（相手の同意が必要）</button>`;
    }
    return `<div style="margin:6px 0;padding:8px;border:1px solid #d9c7ef;border-radius:8px;">
      ✅ ${esc(nameOf(partner))} さんとのトレード（${courseList(w.courses)}）が成立済み<br/>${stateHtml}<div style="margin-top:4px;">${btnHtml}</div>
    </div>`;
  }).join("");

  const options = (studs || []).filter(s => String(s.id) !== myId)
    .map(s => `<option value="${s.id}">${s.attendance_number} ${esc(s.name)}</option>`).join("");

  appEl.insertAdjacentHTML("beforeend", `
    <div class="card" id="swap-card">
      <b style="color:#7b3fb3;">🔄 友達とトレード（交換）</b>
      <p class="small-muted">交換したい相手を選び、交換するクールにチェックを入れて申請してください。相手が承認すると交換が成立します。同じクール番号どうしで入れ替わり、交換後に2人とも3:3のルールを満たしている場合だけ申請できます（2クールまとめての交換もOK）。交換した枠は表の中で紫色の🔄付きで表示されます。黒潮プロジェクトの枠と留学の枠は交換できません。宿泊の回答は交換後にやり直しになります。</p>
      ${incomingHtml}
      ${outgoingHtml ? `<div style="margin:8px 0;"><b class="panel-heading">あなたが申請中のトレード</b>${outgoingHtml}</div>` : ""}
      ${revertHtml ? `<div style="margin:8px 0;"><b class="panel-heading">成立したトレード（2人とも「元に戻す」を押すと元に戻ります）</b>${revertHtml}</div>` : ""}
      <div style="margin-top:10px;">
        <label class="small-muted">交換したい相手</label>
        <select id="swap-partner"><option value="">選んでください</option>${options}</select>
      </div>
      <div id="swap-detail" style="margin-top:10px;"></div>
    </div>
  `);

  document.querySelectorAll("[data-swap-accept]").forEach(btn => {
    btn.onclick = async () => {
      const r = incoming.find(x => x.id === btn.dataset.swapAccept);
      if (!r) return;
      if (!confirm("この内容で交換します。成立すると元に戻せません。よろしいですか？")) return;
      btn.disabled = true;
      const err = await executeSwap(r, studentsById);
      if (err) { alert(err); btn.disabled = false; return; }
      alert("交換が成立しました！");
      location.reload();
    };
  });
  document.querySelectorAll("[data-swap-revert]").forEach(btn => {
    btn.onclick = async () => {
      const w = (doneSwaps || []).find(x => x.id === btn.dataset.swapRevert);
      if (!w) return;
      const iAmFrom = w.from_student === myId;
      const theirs = iAmFrom ? w.revert_to : w.revert_from;
      if (!confirm(theirs
        ? "相手も同意しているので、このトレードを元に戻します。よろしいですか？"
        : "このトレードを元に戻したいと相手に伝えます。相手も「元に戻す」を押すと元に戻ります。よろしいですか？")) return;
      btn.disabled = true;
      const field = iAmFrom ? "revert_from" : "revert_to";
      const { error } = await sb.from("swap_requests").update({ [field]: true }).eq("id", w.id);
      if (error) { alert("失敗しました: " + error.message); btn.disabled = false; return; }
      if (theirs) {
        const err = await revertSwap(w);
        if (err) { alert(err); btn.disabled = false; return; }
        alert("トレードを元に戻しました。");
      } else {
        alert("相手の同意待ちです。相手も「元に戻す」を押すと元に戻ります。");
      }
      location.reload();
    };
  });
  document.querySelectorAll("[data-swap-unrevert]").forEach(btn => {
    btn.onclick = async () => {
      const w = (doneSwaps || []).find(x => x.id === btn.dataset.swapUnrevert);
      if (!w) return;
      const field = w.from_student === myId ? "revert_from" : "revert_to";
      await sb.from("swap_requests").update({ [field]: false }).eq("id", w.id);
      location.reload();
    };
  });
  document.querySelectorAll("[data-swap-decline]").forEach(btn => {
    btn.onclick = async () => {
      if (!confirm("この申請を断りますか？")) return;
      await sb.from("swap_requests").update({ status: "declined" }).eq("id", btn.dataset.swapDecline);
      location.reload();
    };
  });
  document.querySelectorAll("[data-swap-withdraw]").forEach(btn => {
    btn.onclick = async () => {
      if (!confirm("この申請を取り下げますか？")) return;
      await sb.from("swap_requests").update({ status: "withdrawn" }).eq("id", btn.dataset.swapWithdraw);
      location.reload();
    };
  });

  document.getElementById("swap-partner").onchange = async (ev) => {
    const partnerId = ev.target.value;
    const detail = document.getElementById("swap-detail");
    if (!partnerId) { detail.innerHTML = ""; return; }
    detail.innerHTML = `<p class="small-muted">読み込み中...</p>`;
    const theirs = await loadSwapAssigns(partnerId);
    const theirQuota = studentsById[partnerId] ? studentsById[partnerId].kuroshio_quota || null : null;
    const rows = [1, 2, 3, 4, 5, 6].map(c => {
      const a = mine.find(x => x.course_number === c), b = theirs.find(x => x.course_number === c);
      const blocked = !a || !b || swapBlockedReason(a) || swapBlockedReason(b) || (a && b && a.slot_id === b.slot_id);
      return `<tr>
        <td><input type="checkbox" class="swap-course" value="${c}" ${blocked ? "disabled" : ""}/></td>
        <td>${window.COURSE_LABELS[c - 1]}</td>
        <td>${esc(swapSlotLabel(a))}</td>
        <td>${esc(swapSlotLabel(b))}</td>
      </tr>`;
    }).join("");
    detail.innerHTML = `
      <div style="overflow-x:auto;">
        <table class="slots"><thead><tr><th></th><th>クール</th><th>あなたの枠</th><th>相手の枠</th></tr></thead><tbody>${rows}</tbody></table>
      </div>
      <div id="swap-check" class="notice info" style="margin-top:8px;">交換するクールにチェックを入れてください。</div>
      <button id="swap-submit" disabled>この内容で交換を申請する</button>
    `;
    const update = () => {
      const courses = [...document.querySelectorAll(".swap-course:checked")].map(x => Number(x.value));
      const err = courses.length ? validateSwap(mine, theirs, courses, myQuota, theirQuota) : "交換するクールにチェックを入れてください。";
      const box = document.getElementById("swap-check");
      box.className = "notice " + (err ? "warn" : "success");
      box.textContent = err || "この交換は3:3のルールを満たしています。申請できます。";
      document.getElementById("swap-submit").disabled = !!err;
    };
    document.querySelectorAll(".swap-course").forEach(cb => cb.onchange = update);
    document.getElementById("swap-submit").onclick = async () => {
      const courses = [...document.querySelectorAll(".swap-course:checked")].map(x => Number(x.value)).sort();
      if (validateSwap(mine, theirs, courses, myQuota, theirQuota)) return;
      if (!confirm(`${nameOf(partnerId)} さんに、${courseList(courses)}の交換を申請します。よろしいですか？`)) return;
      // 相手から同じ内容の申請がすでに来ていれば、その場で交換成立
      const same = incoming.find(r => r.from_student === String(partnerId)
        && (r.courses || []).map(Number).sort().join(",") === courses.join(","));
      if (same) {
        const err = await executeSwap(same, studentsById);
        if (err) { alert(err); return; }
        alert("相手からも同じ申請が来ていたので、交換が成立しました！");
        location.reload();
        return;
      }
      const { error } = await sb.from("swap_requests").insert({ from_student: myId, to_student: String(partnerId), courses, status: "pending" });
      if (error) { alert("申請に失敗しました: " + error.message); return; }
      alert("申請しました。相手が承認すると交換が成立します。");
      location.reload();
    };
  };
}


// ============================================================
// 空き枠トレード（学生画面）
// 自分の確定枠を、同じクール・同じ種類（院内内科・院内外科・院外内科・院外外科）の空き枠に移す申請。
// 締切後に移動先ごとに抽選し、当たれば移動、外れれば元の枠のまま。
// ============================================================
async function renderMoveSection(student) {
  const { data: runs } = await sb.from("move_runs").select("*").order("run_number");
  if (!runs || runs.length === 0) return;
  const now = Date.now();
  const openRun = runs.find(r => r.status === "open" && r.start_at && r.deadline
    && now >= new Date(r.start_at).getTime() && now <= new Date(r.deadline).getTime());
  const upcoming = runs.find(r => r.status === "open" && r.start_at && now < new Date(r.start_at).getTime());
  const doneRuns = runs.filter(r => r.status === "done");
  const lastDone = doneRuns[doneRuns.length - 1];
  const KL = { IN_N: "院内・内科系", IN_G: "院内・外科系", EX_N: "院外・内科系", EX_G: "院外・外科系" };
  const myId = String(student.id);

  let html = "";

  // 直近の結果とアナウンス
  if (lastDone) {
    const { data: myRes } = await sb.from("move_requests").select("*").eq("run_id", lastDone.id).eq("student_id", myId);
    const { data: slotNames } = await sb.from("slots").select("id, facility_name, department_name");
    const nm = {};
    (slotNames || []).forEach(x => { nm[String(x.id)] = `${x.facility_name} ${x.department_name}`; });
    const resHtml = (myRes || []).filter(r => r.status === "won" || r.status === "lost").map(r =>
      r.status === "won"
        ? `<div class="notice success">🎉 ${window.COURSE_LABELS[r.course_number - 1]}：「${esc(nm[String(r.to_slot)] || "")}」への移動が成立しました。</div>`
        : `<div class="notice warn">${window.COURSE_LABELS[r.course_number - 1]}：「${esc(nm[String(r.to_slot)] || "")}」への移動は抽選に外れたため、元の「${esc(nm[String(r.from_slot)] || "")}」のままです。</div>`
    ).join("");
    const freed = Array.isArray(lastDone.freed) ? lastDone.freed : [];
    const freedHtml = freed.length
      ? `<ul style="margin:6px 0 0;padding-left:18px;">${freed.map(f => `<li>${window.COURSE_LABELS[f.course - 1]}：${esc(f.facility_name)} ${esc(f.department_name)}（${KL[f.combo] || ""}）</li>`).join("")}</ul>`
      : `<div class="small-muted">新しく空いた枠はありませんでした。</div>`;
    html += `${resHtml}
      <div class="card" style="border:2px solid #2e7d6b;">
        <b>📢 第${lastDone.run_number}回 空き枠トレードの結果：新しく空いた枠</b>
        ${freedHtml}
        ${upcoming || openRun ? `<div class="small-muted" style="margin-top:6px;">次の回で、これらの枠への移動を申請できます。</div>` : ""}
      </div>`;
  }

  if (upcoming && !openRun) {
    html += `<div class="card"><b>🔁 空き枠トレード 第${upcoming.run_number}回</b>
      <div class="small-muted">申請受付は ${fmtDate(upcoming.start_at)} から ${fmtDate(upcoming.deadline)} までです。</div></div>`;
  }

  if (openRun) {
    const [{ data: mine }, { data: slots }, { data: allAs }, { data: lim }, { data: myReqs }] = await Promise.all([
      sb.from("assignments").select("id, course_number, slot_id, count_exempt, slots(facility_name, department_name, institution_type, category)").eq("student_id", student.id),
      sb.from("slots").select("*").eq("active", true),
      sb.from("assignments").select("slot_id, course_number"),
      sb.from("facility_limits").select("*"),
      sb.from("move_requests").select("*").eq("run_id", openRun.id).eq("student_id", myId).eq("status", "pending"),
    ]);
    const used = {}, facUsed = {}, slotById = {};
    (slots || []).forEach(x => { slotById[String(x.id)] = x; });
    (allAs || []).forEach(a => {
      used[String(a.slot_id) + "_" + a.course_number] = (used[String(a.slot_id) + "_" + a.course_number] || 0) + 1;
      const x = slotById[String(a.slot_id)];
      if (x) facUsed[x.facility_name + "_" + a.course_number] = (facUsed[x.facility_name + "_" + a.course_number] || 0) + 1;
    });
    const limMap = {};
    (lim || []).forEach(f => { limMap[f.facility_name] = f.max_total; });
    const remainOf = (x, c) => {
      let r = (x["cap_" + c] || 0) - (used[String(x.id) + "_" + c] || 0);
      const l = limMap[x.facility_name];
      if (l != null) r = Math.min(r, l - (facUsed[x.facility_name + "_" + c] || 0));
      return r;
    };
    const myQuota = student.kuroshio_quota || null;

    // 移動先の候補（クールごと）。自分がすでにそのクールで入っている枠は除く
    const kOf = x => (x.institution_type === "internal" ? "IN" : "EX") + "_" + (x.category === "internal_medicine" ? "N" : "G");
    const myCourseSlot = {};
    (mine || []).forEach(a => { myCourseSlot[a.course_number] = String(a.slot_id); });
    const candsFor = c => (slots || []).filter(x => {
      if (String(x.id) === myCourseSlot[c]) return false;
      const xd = (x.department_name || "") + (x.facility_name || "");
      if (xd.includes("黒潮医療人養成プロジェクト") && !(Array.isArray(x.new_courses) && x.new_courses.map(Number).includes(c))) return false;
      if ((x.facility_name || "").startsWith("留学")) return false;
      if (!quotaAllows(x, myQuota)) return false;
      return remainOf(x, c) > 0;
    });
    window.__mvOptsFor = (c, key, selectedId) => {
      const list = candsFor(c).slice().sort((x, y) => (kOf(x) === key ? 0 : 1) - (kOf(y) === key ? 0 : 1));
      return `<option value="">（移動しない）</option>` + list.map(x =>
        `<option value="${x.id}" data-combo="${kOf(x)}" ${selectedId && String(selectedId) === String(x.id) ? "selected" : ""}>[${KL[kOf(x)]}] ${esc(x.facility_name)} ${esc(x.department_name)}（残り${remainOf(x, c)}）</option>`).join("");
    };
    // 移動できる自分のクール（黒潮・留学の枠は動かせない）
    const movable = (mine || []).filter(a => {
      const dep = (a.slots.department_name || "") + (a.slots.facility_name || "");
      return !a.count_exempt && !dep.includes("黒潮医療人養成プロジェクト");
    }).map(a => a.course_number).sort();

    const rows = (mine || []).sort((a, b) => a.course_number - b.course_number).map(a => {
      const c = a.course_number;
      const dep = (a.slots.department_name || "") + (a.slots.facility_name || "");
      if (a.count_exempt || dep.includes("黒潮医療人養成プロジェクト")) {
        return `<tr><td>${window.COURSE_LABELS[c - 1]}</td><td>${esc(a.slots.facility_name)} ${esc(a.slots.department_name)}</td><td class="small-muted">この枠は移動できません</td></tr>`;
      }
      const key = kOf(a.slots);
      const pending = (myReqs || []).find(r => r.course_number === c);
      // 学年代表が個別に登録した申請（種類の違う枠への移動など）は、学生側では変更できないようにする
      if (pending && pending.allow_cross) {
        const toS = slotById[String(pending.to_slot)];
        return `<tr><td>${window.COURSE_LABELS[c - 1]}</td>
          <td>${esc(a.slots.facility_name)} ${esc(a.slots.department_name)}<br/><span class="small-muted">${KL[key]}</span></td>
          <td><b>${toS ? esc(toS.facility_name + " " + toS.department_name) : "（移動先）"}</b><div class="small-muted" style="color:#2e7d6b;">申請中（学年代表が登録した申請です）</div></td></tr>`;
      }
      const toCourse = pending ? Number(pending.to_course || pending.course_number) : c;
      const courseOpts = movable.map(x => `<option value="${x}" ${x === toCourse ? "selected" : ""}>${window.COURSE_LABELS[x - 1]}${x === c ? "（同じクール）" : "へ"}</option>`).join("");
      return `<tr>
        <td>${window.COURSE_LABELS[c - 1]}</td>
        <td>${esc(a.slots.facility_name)} ${esc(a.slots.department_name)}<br/><span class="small-muted">${KL[key]}</span></td>
        <td>
          <select class="move-course" data-course="${c}">${courseOpts}</select>
          <select class="move-target" data-course="${c}" data-from="${a.slot_id}" data-combo="${key}" style="margin-top:4px;">
            ${window.__mvOptsFor(toCourse, key, pending ? pending.to_slot : null)}
          </select>
          ${pending ? `<div class="small-muted" style="color:#2e7d6b;">申請中${pending.bundle_id && (myReqs || []).filter(r => r.bundle_id === pending.bundle_id).length > 1 ? "（セット申請）" : ""}</div>` : ""}
        </td>
      </tr>`;
    }).join("");

    // みんなの申請状況（誰がどこからどこへ申請しているか）
    const [{ data: allReqs }, { data: allStuds }] = await Promise.all([
      sb.from("move_requests").select("student_id, course_number, to_course, from_slot, to_slot, bundle_id").eq("run_id", openRun.id).eq("status", "pending"),
      sb.from("students").select("id, attendance_number, name"),
    ]);
    const bundleSize = {};
    (allReqs || []).forEach(r => { if (r.bundle_id) bundleSize[r.bundle_id] = (bundleSize[r.bundle_id] || 0) + 1; });
    const sn = {};
    (allStuds || []).forEach(x => { sn[String(x.id)] = x; });
    const slotName = id => { const x = slotById[String(id)]; return x ? `${x.facility_name} ${x.department_name}` : "（無効な枠）"; };
    const toCount = {};
    const tc = r => Number(r.to_course || r.course_number);
    (allReqs || []).forEach(r => { const k = r.to_slot + "_" + tc(r); toCount[k] = (toCount[k] || 0) + 1; });
    const publicRows = (allReqs || [])
      .slice().sort((x, y) => x.course_number - y.course_number || String(x.to_slot).localeCompare(String(y.to_slot)))
      .map(r => {
        const st = sn[String(r.student_id)];
        const toS = slotById[String(r.to_slot)];
        const remain = toS ? remainOf(toS, tc(r)) : 0;
        const n = toCount[r.to_slot + "_" + tc(r)] || 0;
        const comp = n > remain ? `<span style="color:#b3413a;font-weight:700;">抽選（${n}人／空き${remain}）</span>` : `<span class="small-muted">${n}人／空き${remain}</span>`;
        return `<tr><td>${window.COURSE_LABELS[r.course_number - 1]}</td><td>${st ? st.attendance_number + " " + esc(st.name) : "?"}</td>
          <td>${esc(slotName(r.from_slot))}</td><td>→</td><td>${tc(r) !== Number(r.course_number) ? `<span class="small-muted">${window.COURSE_LABELS[tc(r) - 1]}の</span>` : ""}<b>${esc(slotName(r.to_slot))}</b>${r.bundle_id && bundleSize[r.bundle_id] > 1 ? `<div class="small-muted">（セット申請）</div>` : ""}</td><td>${comp}</td></tr>`;
      }).join("");
    html += `<div class="card">
      <b>🔁 みんなの空き枠トレード申請（第${openRun.run_number}回）</b>
      ${publicRows ? `<div style="overflow-x:auto;"><table class="slots" style="margin-top:6px;"><thead><tr><th>クール</th><th>名前</th><th>今の枠</th><th></th><th>移動したい枠</th><th>状況</th></tr></thead><tbody>${publicRows}</tbody></table></div>`
        : `<p class="small-muted">まだ申請はありません。</p>`}
    </div>`;

    html += `<div class="card" style="border:2px solid #2fa3c9;">
      <b>🔁 空き枠トレード 第${openRun.run_number}回（申請受付中）</b>
      <div class="countdown-box" style="margin:6px 0;">締切：${fmtDate(openRun.deadline)}</div>
      <p class="small-muted">今の確定枠を、同じクールの空き枠に移したい場合は、移動先を選んで「申請を保存」を押してください。締切後に抽選し、当たれば移動、外れれば今の枠のままです。宿泊の回答は移動後にやり直しになります。</p>
      <p class="small-muted"><b>同じクール・同じ種類への移動</b>（例：⑤の院外外科→⑤の別の院外外科）は、1つずつ抽選されます。<br/>
      <b>クールや種類を入れ替える移動</b>（例：⑤の院外外科を⑥の院外外科へ、⑥の院内内科を⑤の院内内科へ）は、上のプルダウンで移動先のクール、下のプルダウンで移動先の枠を選んでください。複数のクールをまとめた「セット申請」になり、<b>すべての移動先に当たった場合だけ</b>まとめて移動します。どれか1つでも外れたら、全部今の枠のままです。移動先のクールの組み合わせと、種類の組み合わせが元と同じ（どのクールも1つずつ埋まり、3:3のルールが崩れない）場合だけ保存できます。</p>
      <div style="overflow-x:auto;"><table class="slots"><thead><tr><th>クール</th><th>今の枠</th><th>移動先</th></tr></thead><tbody>${rows}</tbody></table></div>
      <div id="move-check" class="notice info" style="margin-top:8px;">移動したいクールの移動先を選んでください。</div>
      <button id="move-save" style="margin-top:8px;">申請を保存</button>
    </div>`;
  }

  if (!html) return;
  appEl.insertAdjacentHTML("beforeend", html);

  const saveBtn = document.getElementById("move-save");
  if (saveBtn && openRun) {
    const KLs = { IN_N: "院内内科", IN_G: "院内外科", EX_N: "院外内科", EX_G: "院外外科" };
    // 選んだ内容を「同じ種類の移動（1つずつ）」と「種類を入れ替える移動（セット）」に分けてチェックする
    const analyze = () => {
      const toCourseOf = c => { const el = document.querySelector(`.move-course[data-course="${c}"]`); return el ? Number(el.value) : c; };
      const all = [...document.querySelectorAll(".move-target")].map(x => ({
        course: Number(x.dataset.course), toCourse: toCourseOf(Number(x.dataset.course)),
        from: String(x.dataset.from), to: String(x.value),
        oldK: x.dataset.combo, newK: x.value ? x.selectedOptions[0].dataset.combo : null,
      }));
      let err = null;
      const incomplete = all.find(x => x.toCourse !== x.course && !x.to);
      if (incomplete) err = `${window.COURSE_LABELS[incomplete.course - 1]}の移動先クールを変えた場合は、移動先の枠も選んでください。`;
      const chosen = all.filter(x => x.to);
      // 同じクール・同じ種類の移動は1つずつ、それ以外（種類やクールを入れ替える移動）はまとめてセット申請
      const singles = chosen.filter(x => x.oldK === x.newK && x.toCourse === x.course);
      const cross = chosen.filter(x => !(x.oldK === x.newK && x.toCourse === x.course));
      if (!err && cross.length > 0) {
        const fromSet = cross.map(x => x.course).sort().join(","), toSet = cross.map(x => x.toCourse).sort().join(",");
        if (fromSet !== toSet) {
          err = `クールを入れ替える場合は、移動先のクールにも今の枠があるので、そのクールの枠もどこかへ移動させてください（今：${cross.map(x => window.COURSE_LABELS[x.course - 1]).join("・")} → 移動先：${cross.map(x => window.COURSE_LABELS[x.toCourse - 1]).join("・")}）。`;
        }
      }
      if (!err && cross.length > 0) {
        const a = cross.map(x => x.oldK).sort().join(","), b = cross.map(x => x.newK).sort().join(",");
        if (a !== b) {
          err = `種類を入れ替える移動は、組み合わせが元と同じになるようにしてください（今：${cross.map(x => KLs[x.oldK]).join("・")} → 移動後：${cross.map(x => KLs[x.newK]).join("・")}）。このままだと3:3のルールが崩れます。`;
        }
      }
      return { chosen, singles, cross, err };
    };
    const refresh = () => {
      const { chosen, singles, cross, err } = analyze();
      const box = document.getElementById("move-check");
      if (err) { box.className = "notice warn"; box.textContent = err; saveBtn.disabled = true; return; }
      saveBtn.disabled = false;
      if (chosen.length === 0) { box.className = "notice info"; box.textContent = "移動したいクールの移動先を選んでください（何も選ばずに保存すると、申請を取り下げます）。"; return; }
      const parts = [];
      if (singles.length) parts.push(`同じ種類の移動 ${singles.length}件（1つずつ抽選）`);
      if (cross.length) parts.push(`セット申請 ${cross.map(x => window.COURSE_LABELS[x.course - 1] + (x.toCourse !== x.course ? "→" + window.COURSE_LABELS[x.toCourse - 1] : "")).join("・")}（全部当たった場合だけ移動）`);
      box.className = "notice success";
      box.textContent = "申請できます：" + parts.join("／");
    };
    document.querySelectorAll(".move-target").forEach(x => x.onchange = refresh);
    // 移動先のクールを変えたら、そのクールの空き枠に選択肢を作り直す
    document.querySelectorAll(".move-course").forEach(sel => sel.onchange = () => {
      const c = Number(sel.dataset.course);
      const tgt = document.querySelector(`.move-target[data-course="${c}"]`);
      tgt.innerHTML = window.__mvOptsFor(Number(sel.value), tgt.dataset.combo, null);
      refresh();
    });
    refresh();

    saveBtn.onclick = async () => {
      const { singles, cross, err } = analyze();
      if (err) { alert(err); return; }
      saveBtn.disabled = true;
      const sels = [...document.querySelectorAll(".move-target")];
      // いったんこの回の自分の申請を取り下げて、選んだ内容で出し直す
      await sb.from("move_requests").update({ status: "withdrawn" })
        .eq("run_id", openRun.id).eq("student_id", myId).eq("status", "pending")
        .or("allow_cross.is.null,allow_cross.eq.false"); // 学年代表が登録した申請は残す
      const newId = () => (crypto.randomUUID ? crypto.randomUUID() : "b" + Date.now() + Math.random().toString(16).slice(2));
      const crossBundle = newId();
      const rows = []
        .concat(singles.map(x => ({ run_id: openRun.id, student_id: myId, course_number: x.course, to_course: x.course, from_slot: x.from, to_slot: x.to, status: "pending", bundle_id: newId() })))
        .concat(cross.map(x => ({ run_id: openRun.id, student_id: myId, course_number: x.course, to_course: x.toCourse, from_slot: x.from, to_slot: x.to, status: "pending", bundle_id: crossBundle })));
      void sels;
      if (rows.length > 0) {
        const { error } = await sb.from("move_requests").insert(rows);
        if (error) { alert("保存に失敗しました: " + error.message); saveBtn.disabled = false; return; }
      }
      alert(rows.length > 0 ? `${rows.length}件の移動を申請しました。締切後に抽選されます。` : "申請をすべて取り下げました。");
      location.reload();
    };
  }
}
