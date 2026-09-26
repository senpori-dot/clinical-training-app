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
function isCampaignEligible(round, counts, instCounts) {
  if (!round || round.eligibility !== "ext_surgery_2") return true;
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

// 詰みの人へのお知らせポップアップ（ラウンドごとに1回）
function maybeShowStuckPopup(student, round) {
  const key = `stuck_popup_${student.id}_${round ? round.id : "none"}`;
  try {
    if (localStorage.getItem(key)) return;
    localStorage.setItem(key, "1");
  } catch (e) { /* 保存できなくても表示はする */ }
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
  try {
    if (localStorage.getItem(key)) return;
    localStorage.setItem(key, "1");
  } catch (e) { /* 保存できなくても表示はする */ }
  showOrQueuePopup(() => {
    const root = document.getElementById("facility-modal-root");
    let body = `院外・外科系を先行して2つ選んでいただき、ありがとうございます！\n\n${roundLabel(round)}では何を選んでいただいても、このラウンドが終了した後に、ひと枠先行して決められる枠をプレゼントします。`;
    if (onlyExtNaika) {
      body += `\n\n※ただしあなたは院外・内科系がまだ足りていないため、今回は院外・内科系の枠のみ選択できます。`;
    }
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
  try {
    if (localStorage.getItem(key)) return;
    localStorage.setItem(key, "1");
  } catch (e) { /* 保存できなくても表示はする */ }
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
  try {
    if (localStorage.getItem(key)) return;
    localStorage.setItem(key, "1");
  } catch (e) { /* 保存できなくても表示はする */ }
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
  try {
    if (localStorage.getItem(key)) return;
    localStorage.setItem(key, "1");
  } catch (e) { /* 保存できなくても表示はする */ }
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
  try {
    if (localStorage.getItem(key)) return;
    localStorage.setItem(key, "1");
  } catch (e) { /* 保存できなくても表示はする */ }

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
      await sb.from("assignments").update({ lodging_choice: choice }).eq("id", id);
      location.reload();
    };
  });
  document.querySelectorAll(".lodging-change-btn").forEach(btn => {
    btn.onclick = async () => {
      if (!confirm("回答を変更しますか？")) return;
      await sb.from("assignments").update({ lodging_choice: null }).eq("id", btn.dataset.id);
      location.reload();
    };
  });
}

async function renderApp(student, round, assignments, lodgingSettings) {
  const { counts, instCounts, catCounts, filledCourses } = computeState(assignments);
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
    } else {
      nextRoundNotice = `<div class="small-muted">次のラウンドの開始時刻は、決まり次第お知らせします。</div>`;
    }
  }

  if (!noRound) {
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
  const campaignIneligible = !!(round && round.eligibility === "ext_surgery_2" && !allDone && !isCampaignEligible(round, counts, instCounts));
  if (campaignIneligible) {
    canEdit = false;
    statusNotice = `<div class="notice info">「${esc(roundLabel(round))}」は、<b>院外外科を2つ取っていて、院外が3つ揃っている人</b>だけが参加できるラウンドです。あなたは対象外のため、表は閲覧のみです。次のラウンドをお待ちください。</div>`;
  } else if (round && round.eligibility === "ext_surgery_2" && !allDone && canEdit) {
    statusNotice = `<div class="notice success">🎁 院外外科を2つ取って院外内科を譲ってくれてありがとうございます！このラウンドは対象者だけが参加できる特別ラウンドです。</div>` + statusNotice;
  }

  // 第4希望（2次・3次マッチング含む）：院外がまだ3つ揃っていない人は院外しか選べない
  const forceExternal = !!(round && round.round_number === 4 && !allDone && instCounts.external < 3);
  // 院外内科が必要なのに足りていない人は院外内科しか選べない
  //  ・院内外科を2つ取っていて、院外内科が2つに満たない人
  //  ・院外内科をまだ1つも取っていない人
  // 第4希望以降（キャンペーン・第5・第6希望も含む）で適用。院外内科が必要数に達したら自動で外れる
  const roundOrder = round ? (round.display_order ?? round.round_number) : 0;
  const forceExtNaika = !!(round && roundOrder >= 4 && !allDone
    && ((counts.IN_G === 2 && counts.EX_N < 2) || counts.EX_N === 0));
  window.__forceExternal = forceExternal;
  window.__forceExtNaika = forceExtNaika;
  // 院内・院外がすでに3つ揃っている人は、そちらをもう選べない（留学・黒潮の枠も院内/院外として数える）
  window.__instFull = { internal: instCounts.internal >= 3, external: instCounts.external >= 3 };
  if (forceExtNaika && canEdit) {
    statusNotice += `<div class="notice warn">あなたは<b>院外・内科系の枠しか選べません</b>（院外内科が3:3ルールの必要数に足りていないため）。それ以外の枠はタップできません。</div>`;
  } else if (forceExternal && canEdit) {
    statusNotice += `<div class="notice warn">第4希望では、院外がまだ3つ揃っていない人は<b>院外の枠しか選べません</b>（あなたは院外 ${instCounts.external}/3）。院内の枠はタップできません。</div>`;
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
      && !/^南/.test((student.name || "").trim())) {
    maybeShowCampaignThanksPopup(student, round, attempt, forceExtNaika);
  }
  // 第4希望：院外内科1・院外外科1の人（佐伯さん・谷口さんを除く）に、院外外科を取ればキャンペーンで先行できることを案内
  if (round && round.round_number === 4 && !allDone && !forceExtNaika
      && counts.EX_N === 1 && counts.EX_G === 1
      && comboEligible(counts, "EX_G", feasible)
      && !/^(佐伯|谷口)/.test((student.name || "").trim())) {
    maybeShowCampaignInvitePopup(student, round, attempt);
  }
  if (canEdit && !allDone && !forceExtNaika) {
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

  const { data: allAssignments } = await sb
    .from("assignments")
    .select("slot_id, course_number, lodging_choice, students(attendance_number, name)");

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
    const mine = assignments.map(a => ({
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

    const { data: allStudents } = await sb.from("students").select("id");
    const { data: myAssignCounts } = await sb.from("assignments").select("student_id, slot_id, count_exempt");
    const cnt = {};
    (myAssignCounts || []).forEach(a => { cnt[a.student_id] = (cnt[a.student_id] || 0) + 1; });
    const totalStudents = (allStudents || []).length;
    const doneCount = (allStudents || []).filter(s => (cnt[s.id] || 0) >= 6).length;
    let targetCount = totalStudents - doneCount; // このラウンド開始時点で参加すべきだった人数
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
      targetCount = (allStudents || []).filter(s => (cnt[s.id] || 0) < 6 && (exG[s.id] || 0) >= 2 && (ext[s.id] || 0) >= 3).length;
    }

    // 2次・3次では、前の回で「確定した人」を毎回差し引く。
    // 落選した人だけでなく、投票し忘れた人・キャンセルした人も自動的に対象人数に残る。
    for (let a = 1; a < displayAttempt; a++) {
      const { data: confirmedAtA } = await sb
        .from("preferences")
        .select("student_id")
        .eq("round_id", round.id)
        .eq("attempt", a)
        .eq("status", "confirmed");
      targetCount -= new Set((confirmedAtA || []).map(p => p.student_id)).size;
    }

    const attemptWord = displayAttempt === 1 ? "1次" : displayAttempt === 2 ? "2次" : "3次";
    appEl.insertAdjacentHTML("beforeend", `<div class="card"><b>${votedCount}/${targetCount}人</b><span class="small-muted"> が${attemptWord}マッチングの対象者のうち、すでに希望を提出しています。</span></div>`);
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
      <p class="small-muted">枠の縁の色は希望者数の状況（青=空きあり、オレンジ=ちょうど定員、赤=超過）を常に表示します。すでに確定人数だけで満員になった枠は、他の未確定枠と区別しやすいようグレー表示にしています。院外の表は、同じ病院ごとに太線で区切っています。施設名をタップすると、宿泊・集合時間・連絡事項の詳細が見られます。定員を超えていても締切までは希望を出せ、締切後に自動で抽選されます。宿泊が絡む施設は最初から氏名が表示されます。宿泊が絡まない施設は、抽選で確定するまで氏名は表示されません（人数のみ）。</p>
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

  const confirmedNamesHtml = confirmedHere.map(a =>
    a.students.attendance_number === student.attendance_number
      ? `<span class="me-confirmed">✔ ${esc(a.students.name)}(あなた)</span>${lodgingTag(a)}`
      : `<b class="${lodging ? (a.lodging_choice === 'yes' ? 'name-lodging-yes' : a.lodging_choice === 'no' ? 'name-lodging-no' : 'name-lodging-unanswered') : ''}">${esc(a.students.name)}</b>${lodgingTag(a)}`
  ).join("<br>");

  // 匿名ルール：
  // ・宿泊が絡む施設 → 最初から全員に氏名を表示（部屋割り調整のため）。
  // ・宿泊が絡まない施設 → 抽選確定(confirmed)するまでは氏名を出さない（自分自身の分を除く）。
  let pendingNamesHtml = "";
  if (lodging) {
    pendingNamesHtml = pendingHere.map(p =>
      p.student_id === student.id ? `<b>あなた（${esc(p.students.name)}）</b>` : esc(p.students.name)
    ).join("<br>");
  } else {
    const shown = [];
    let hiddenCount = 0;
    for (const p of pendingHere) {
      if (p.student_id === student.id) shown.push(`<b>あなた</b>`);
      else hiddenCount++;
    }
    if (hiddenCount > 0) shown.push(`${hiddenCount}名希望中`);
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
