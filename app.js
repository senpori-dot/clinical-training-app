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

  const { data: rounds } = await sb.from("rounds").select("*").order("round_number");
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
      <td><b>第${r.round_number}希望</b></td>
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
<p>基本的に、1つのラウンドについては2次マッチングまでで終了する予定です。そのため、2次マッチングでも抽選に外れてしまった場合は、そのラウンドでは枠を確保できなかったという扱いになります。</p>
<p>ただし、次のラウンドが始まるまでに個別にLINEをいただければ、空き状況を見て調整できる場合があります。原則として翌日12時までに連絡してください。ただし、同じ空き枠を複数人が希望している場合などは、希望通りに調整できない可能性があります。</p>
<p>また、第5・第6ラウンドあたりになると空き枠自体が少なくなり、2次マッチングまででは全員決まらない可能性もあります。その場合は、状況を見て3次マッチングを追加するなど、必要に応じて対応します。</p>

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

function startCountdown(targetIso) {
  const target = new Date(targetIso).getTime();
  const timerEl = document.getElementById("countdown-timer");
  if (!timerEl) return;
  function tick() {
    const el = document.getElementById("countdown-timer");
    if (!el) return; // ページが差し替わったら停止
    const diff = target - Date.now();
    if (diff <= 0) {
      el.textContent = "まもなく処理されます…";
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

  let html = "";

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

  // 宿泊が必要な確定先について、宿泊するかどうかの回答を求める
  const lodgingNeeded = assignments.filter(a => requiresLodging(a.slots));
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
                  ? `<span class="${a.lodging_choice === 'yes' ? 'me-confirmed' : ''}">${a.lodging_choice === 'yes' ? '✔ 宿泊する' : '宿泊しない'}</span>
                     <button class="small secondary lodging-change-btn" data-id="${a.id}">変更</button>`
                  : `<button class="small lodging-btn" data-id="${a.id}" data-choice="yes">宿泊する</button>
                     <button class="small secondary lodging-btn" data-id="${a.id}" data-choice="no">宿泊しない</button>`
                }
              </td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>`;
  }

  if (allDone) {
    html += `<div class="notice confirmed">すべてのクールが確定しました。お疲れ様でした。</div>`;
    appEl.innerHTML = html;
    attachLodgingHandlers();
    maybeShowResultReveal("all-done-" + student.id, "alldone", "6クールすべての実習先が決まりました。お疲れ様でした！");
    return;
  }

  const now = new Date();
  const noRound = !round;

  if (noRound) {
    html += `<div class="notice info">現在、募集中のラウンドはありません。事務局からの案内をお待ちください（下の表は閲覧のみです）。</div>`;
  }

  const notStarted0 = !noRound && round.start_at && now < new Date(round.start_at);
  const firstEnded0 = !noRound && round.end_at && now > new Date(round.end_at);
  const secondEnded0 = !noRound && round.second_deadline && now > new Date(round.second_deadline);

  let countdownTarget = null, countdownLabel = "";
  if (!noRound && notStarted0) { countdownTarget = round.start_at; countdownLabel = "開始まで"; }
  else if (!noRound && round.phase === "first_choice" && !firstEnded0 && round.end_at) { countdownTarget = round.end_at; countdownLabel = "1次締切まで"; }
  else if (!noRound && round.phase === "second_match" && !secondEnded0 && round.second_deadline) { countdownTarget = round.second_deadline; countdownLabel = "2次締切まで"; }

  if (!noRound) {
    html += `<div class="card"><b>現在のラウンド：第${round.round_number}希望</b>`;
    if (round.start_at) html += `<div class="small-muted">開始: ${fmtDate(round.start_at)}</div>`;
    if (round.end_at) html += `<div class="small-muted">1次締切: ${fmtDate(round.end_at)}</div>`;
    if (round.second_deadline) html += `<div class="small-muted">2次締切: ${fmtDate(round.second_deadline)}</div>`;
    if (countdownTarget) {
      html += `<div class="countdown-box"><span id="countdown-label">${countdownLabel}</span> <span id="countdown-timer">--:--:--</span></div>`;
    } else if (!notStarted0 && (round.phase === "closed" || (round.phase === "second_match" && secondEnded0) || (round.phase === "first_choice" && firstEnded0))) {
      html += `<div class="small-muted">次のラウンドの開始時刻は、決まり次第お知らせします。</div>`;
    }
    html += `</div>`;
  }

  const notStarted = notStarted0 || noRound;
  const firstEnded = firstEnded0;
  const secondEnded = secondEnded0;

  let canEdit = false;
  let myPref = null;
  let attempt = !noRound && round.phase === "second_match" ? 2 : 1;

  let statusNotice = "";
  let resultAnimation = "";
  let resultPrefId = null;
  let resultDetailText = "";

  if (notStarted) {
    if (!noRound) statusNotice = `<div class="notice info">このラウンドはまだ開始していません。開始をお待ちください（下の表は閲覧のみ、選択はまだできません）。</div>`;
  } else {
  const { data: pref1 } = await sb
    .from("preferences")
    .select("*, slots(facility_name, department_name, facility_accommodation, accommodation)")
    .eq("student_id", student.id)
    .eq("round_id", round.id)
    .eq("attempt", 1)
    .maybeSingle();

  if (pref1 && pref1.status === "confirmed") {
    // 1次希望で当選・確定済み（ラウンド全体が2次マッチングに進んでいても、この学生自身は1次で決着済み）
    myPref = pref1;
    attempt = 1;
    canEdit = false;
    const wonLottery = pref1.won_lottery === true;
    statusNotice = `<div class="notice success">🎉 おめでとうございます！${window.COURSE_LABELS[pref1.course_number-1]}「${esc(pref1.slots.facility_name)} ${esc(pref1.slots.department_name)}」に確定しました。次のラウンドをお待ちください。</div>`;
    resultAnimation = wonLottery ? "win" : "smooth";
    resultPrefId = pref1.id;
    resultDetailText = `${window.COURSE_LABELS[pref1.course_number-1]} ${pref1.slots.facility_name} ${pref1.slots.department_name}`;
  } else {
    attempt = round.phase === "second_match" ? 2 : 1;
    const { data: pref2 } = attempt === 2 ? await sb
      .from("preferences")
      .select("*, slots(facility_name, department_name, facility_accommodation, accommodation)")
      .eq("student_id", student.id)
      .eq("round_id", round.id)
      .eq("attempt", 2)
      .maybeSingle() : { data: null };
    myPref = attempt === 2 ? pref2 : pref1;

    if (round.phase === "closed") {
      statusNotice = `<div class="notice info">このラウンドは終了しました。次のラウンドをお待ちください。</div>`;
    } else if (round.phase === "first_choice" && firstEnded) {
      statusNotice = `<div class="notice info">1次締切時刻を過ぎました。まもなく自動で抽選が行われます。少し時間をおいて再読み込みしてください。</div>`;
    } else if (round.phase === "second_match" && secondEnded) {
      statusNotice = `<div class="notice info">2次締切時刻を過ぎました。まもなく自動で抽選が行われます。少し時間をおいて再読み込みしてください。</div>`;
    } else if (attempt === 1) {
      if (!myPref || myPref.status === "submitted") {
        canEdit = true;
        if (myPref) statusNotice = `<div class="notice confirmed">${window.COURSE_LABELS[myPref.course_number-1]}「${esc(myPref.slots.facility_name)} ${esc(myPref.slots.department_name)}」を希望として提出済みです。表をタップすると変更できます。</div>`;
      } else if (myPref.status === "lost") {
        statusNotice = `<div class="notice warn">1次マッチングに外れました。2次マッチングに進んでください。</div>`;
        resultAnimation = "lose";
        resultPrefId = myPref.id;
        resultDetailText = "1次マッチングに外れました。2次マッチングに進んでください。";
      }
    } else {
      if (pref1 && pref1.status === "lost" && resultAnimation === "") {
        resultAnimation = "lose-once";
        resultPrefId = pref1.id;
        resultDetailText = "1次マッチングに外れました。2次マッチングに進んでください。";
      }
      if (!myPref) {
        canEdit = true;
        statusNotice = `<div class="notice warn">1次マッチングに外れました。空いている枠から2次希望を選んでください。</div>`;
      } else if (myPref.status === "submitted") {
        canEdit = true;
        statusNotice = `<div class="notice confirmed">2次希望として「${esc(myPref.slots.facility_name)} ${esc(myPref.slots.department_name)}」を提出済みです。表をタップすると変更できます。</div>`;
      } else if (myPref.status === "confirmed") {
        const wonLottery = myPref.won_lottery === true;
        statusNotice = `<div class="notice success">🎉 おめでとうございます！2次希望で「${esc(myPref.slots.facility_name)} ${esc(myPref.slots.department_name)}」に確定しました。次のラウンドをお待ちください。</div>`;
        resultAnimation = wonLottery ? "win" : "smooth";
        resultPrefId = myPref.id;
        resultDetailText = `${esc(myPref.slots.facility_name)} ${esc(myPref.slots.department_name)}`;
      } else {
        const finalMsg = "2次希望も抽選に外れました。もし希望する枠があれば、すぐに坂本まで希望の枠をご連絡ください。次のラウンドが始まる前であれば受け付けます。それ以降になった場合は、全クールが確定した後、余っている枠の中から改めて希望を聞きます。";
        statusNotice = `<div class="notice warn">${finalMsg}</div>`;
        resultAnimation = "lose-final";
        resultPrefId = myPref.id;
        resultDetailText = finalMsg;
      }
    }
  }
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
  if (resultAnimation) {
    maybeShowResultReveal(resultPrefId, resultAnimation === "lose-once" ? "lose" : resultAnimation, resultDetailText);
  }
  if (countdownTarget) {
    startCountdown(countdownTarget);
  }

  const { data: slots } = await sb.from("slots").select("*").eq("active", true);
  const { data: facilityLimits } = await sb.from("facility_limits").select("*");
  const limitMap = {};
  (facilityLimits || []).forEach(f => { limitMap[f.facility_name] = f; });

  const { data: roundPrefs } = noRound ? { data: [] } : await sb
    .from("preferences")
    .select("slot_id, course_number, status, reveal_self, student_id, students(attendance_number, name)")
    .eq("round_id", round.id)
    .eq("attempt", attempt)
    .in("status", ["submitted", "lottery", "confirmed"]);

  const { data: allAssignments } = await sb
    .from("assignments")
    .select("slot_id, course_number, students(attendance_number, name)");

  const facilityCourseCount = {};
  const facilityConfirmedCount = {};
  for (const s of slots) {
    if (s.institution_type !== "external") continue;
    for (let c = 1; c <= 6; c++) {
      const confirmedN = allAssignments.filter(a => a.slot_id === s.id && a.course_number === c).length;
      const pendingN = roundPrefs.filter(p => p.slot_id === s.id && p.course_number === c && p.status !== "confirmed").length;
      const key = s.facility_name + "_" + c;
      facilityCourseCount[key] = (facilityCourseCount[key] || 0) + confirmedN + pendingN;
      facilityConfirmedCount[key] = (facilityConfirmedCount[key] || 0) + confirmedN;
    }
  }

  const globalRevealed = noRound || !round.reveal_at || now >= new Date(round.reveal_at);

  if (!noRound) {
    const votedCount = new Set((roundPrefs || []).map(p => p.student_id)).size;
    appEl.insertAdjacentHTML("beforeend", `<div class="card"><b>${votedCount}人</b><span class="small-muted"> が今のラウンドですでに希望を提出しています。</span></div>`);
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
    const lodgingBadge = (!isKuroshioRow && requiresLodging(s)) ? `<div class="lodging-badge">🏨 宿泊あり：氏名を最初から表示</div>` : "";
    rows += `<tr class="${rowClass} ${facilityChanged ? 'facility-start' : ''}"><td class="dept-col facility-tap" data-facility="${esc(s.facility_name)}"><b class="facility-name">${esc(s.facility_name)}</b><br/>${esc(s.department_name)}${limitBadge}${lodgingBadge}</td>`;
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
  if (isKuroshio) {
    const kuroshioConfirmed = allAssignments.filter(a => a.slot_id === slot.id && a.course_number === courseNumber);
    const kuroshioNames = kuroshioConfirmed.map(a => `<b>${esc(a.students.name)}</b>`).join("<br>");
    return `<td class="cell-slot cell-blocked">
      ${kuroshioNames ? `<div class="cell-names">${kuroshioNames}</div>` : ""}
    </td>`;
  }

  const confirmedHere = allAssignments.filter(a => a.slot_id === slot.id && a.course_number === courseNumber);

  if (filledCourses.has(courseNumber)) {
    const namesHtml = confirmedHere.map(a =>
      a.students.attendance_number === student.attendance_number
        ? `<span class="me-confirmed">✔ ${esc(a.students.name)}(あなた)</span>`
        : `<b>${esc(a.students.name)}</b>`
    ).join("<br>");
    return `<td class="cell-slot cell-other-term">
      <div class="cell-cap">${confirmedHere.length}/${cap}</div>
      ${namesHtml ? `<div class="cell-names">${namesHtml}</div>` : ""}
    </td>`;
  }

  const isMine = !!(myPref && myPref.slot_id === slot.id && myPref.course_number === courseNumber &&
    (myPref.status === "submitted" || myPref.status === "lottery"));
  const pendingHere = roundPrefs.filter(p => p.slot_id === slot.id && p.course_number === courseNumber && p.status !== "confirmed");
  const totalCount = confirmedHere.length + pendingHere.length;
  const isExactFull = totalCount === cap;
  const isOverFull = totalCount > cap;
  const confirmedFull = confirmedHere.length >= cap;

  const facilityLimit = limitMap[slot.facility_name];
  const facKey = slot.facility_name + "_" + courseNumber;
  const facCount = facilityCourseCount[facKey] || 0;
  const facilityExact = facilityLimit && facCount === facilityLimit.max_total;
  const facilityOver = facilityLimit && facCount > facilityLimit.max_total;
  const facilityConfirmedFull = facilityLimit && (facilityConfirmedCount[facKey] || 0) >= facilityLimit.max_total;

  const lodging = requiresLodging(slot);

  const confirmedNamesHtml = confirmedHere.map(a => `<b>${esc(a.students.name)}</b>`).join("<br>");

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
      <div class="cell-cap">${totalCount}/${cap}</div>
      <div class="cell-names">${label}</div>
      ${confirmedNamesHtml ? `<div class="cell-names">${confirmedNamesHtml}</div>` : ""}
    </td>`;
  }

  const combo = comboKeyOf(slot);
  let eligible = canEdit && comboEligible(counts, combo, feasible);

  let cls = "cell-slot";
  if (eligible) cls += " cell-open";
  else cls += " cell-ineligible";

  // 枠(ボーダー)の色は定員に対する希望者数の状況を独立して常に示す（誰も希望していない場合は無色）：
  // 空きあり=青、ちょうど定員=オレンジ、超過=赤
  if (totalCount > 0) {
    if (isOverFull || facilityOver) cls += " frame-over";
    else if (isExactFull || facilityExact) cls += " frame-exact";
    else cls += " frame-under";
  }

  // 背景は基本そのままの科目色。自分が選んだものだけ紫背景にする
  if (isMine) cls += " cell-mine";

  const dataAttrs = eligible
    ? `data-slot="${slot.id}" data-course="${courseNumber}" data-institution="${slot.institution_type}" data-facility="${esc(slot.facility_name)}" data-dept="${esc(slot.department_name)}"`
    : "";

  let overNote = "";
  if (isOverFull || facilityOver) overNote = `<div class="cell-names" style="color:#b3413a;">定員超過中</div>`;

  return `<td class="${cls}" ${dataAttrs}>
    <div class="cell-cap">${totalCount}/${cap}</div>
    ${namesHtml ? `<div class="cell-names">${namesHtml}</div>` : ""}
    ${overNote}
  </td>`;
}

async function onCellClick(td, student, round, attempt, myPref) {
  const slotId = td.dataset.slot;
  const courseNumber = Number(td.dataset.course);
  const facility = td.dataset.facility;
  const dept = td.dataset.dept;
  const courseLabel = window.COURSE_LABELS[courseNumber - 1];

  const ok = confirm(`${courseLabel}「${facility} ${dept}」を希望として提出します。よろしいですか？`);
  if (!ok) return;

  td.style.opacity = "0.5";

  if (myPref) {
    const { error } = await sb.from("preferences")
      .update({ slot_id: slotId, course_number: courseNumber, status: "submitted" })
      .eq("id", myPref.id);
    if (error) { alert("送信に失敗しました: " + error.message); td.style.opacity = "1"; return; }
  } else {
    const { error } = await sb.from("preferences").insert({
      student_id: student.id,
      round_id: round.id,
      slot_id: slotId,
      course_number: courseNumber,
      attempt: attempt,
      status: "submitted",
    });
    if (error) { alert("送信に失敗しました: " + error.message); td.style.opacity = "1"; return; }
  }
  location.reload();
}

main();
