const sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
const appEl = document.getElementById("app");
const headerEl = document.getElementById("student-name-header");

const CATEGORY_LABEL = { internal_medicine: "内科系", surgery: "外科系" };
const INSTITUTION_LABEL = { internal: "院内", external: "院外" };

function getToken() {
  const params = new URLSearchParams(window.location.search);
  return params.get("token");
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s ?? "";
  return d.innerHTML;
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

  const { data: round } = await sb
    .from("rounds")
    .select("*")
    .eq("is_current", true)
    .maybeSingle();

  const { data: assignments } = await sb
    .from("assignments")
    .select("course_number, slot_id, slots(institution_type, category, facility_name, department_name)")
    .eq("student_id", student.id);

  renderApp(student, round, assignments || []);
}

function computeRemaining(assignments) {
  const counts = { internal: 0, external: 0, internal_medicine: 0, surgery: 0 };
  const filledCourses = new Set();
  for (const a of assignments) {
    filledCourses.add(a.course_number);
    counts[a.slots.institution_type]++;
    counts[a.slots.category]++;
  }
  return {
    remaining: {
      internal: window.REQUIRED.internal - counts.internal,
      external: window.REQUIRED.external - counts.external,
      internal_medicine: window.REQUIRED.internal_medicine - counts.internal_medicine,
      surgery: window.REQUIRED.surgery - counts.surgery,
    },
    filledCourses,
  };
}

async function renderApp(student, round, assignments) {
  const { remaining, filledCourses } = computeRemaining(assignments);
  const allDone = filledCourses.size >= 6;

  let html = "";

  // ステータス表示
  html += `<div class="card">
    <div class="status-grid">
      <div class="status-box ${remaining.internal<=0?'full':''}"><div class="num">${remaining.internal}</div><div class="label">院内 残り</div></div>
      <div class="status-box ${remaining.external<=0?'full':''}"><div class="num">${remaining.external}</div><div class="label">院外 残り</div></div>
      <div class="status-box ${remaining.internal_medicine<=0?'full':''}"><div class="num">${remaining.internal_medicine}</div><div class="label">内科系 残り</div></div>
      <div class="status-box ${remaining.surgery<=0?'full':''}"><div class="num">${remaining.surgery}</div><div class="label">外科系 残り</div></div>
    </div>
    <div class="small-muted">確定クール: ${filledCourses.size} / 6</div>
  </div>`;

  // 確定済み一覧
  if (assignments.length > 0) {
    html += `<div class="card"><b>確定済みの実習先</b><table class="slots" style="margin-top:8px;"><thead><tr><th>クール</th><th>区分</th><th>実習先</th></tr></thead><tbody>`;
    for (const a of assignments.slice().sort((x,y)=>x.course_number-y.course_number)) {
      html += `<tr><td>${window.COURSE_LABELS[a.course_number-1]}</td><td>${INSTITUTION_LABEL[a.slots.institution_type]}/${CATEGORY_LABEL[a.slots.category]}</td><td>${esc(a.slots.facility_name)} ${esc(a.slots.department_name)}</td></tr>`;
    }
    html += `</tbody></table></div>`;
  }

  if (allDone) {
    html += `<div class="notice confirmed">すべてのクールが確定しました。お疲れ様でした。</div>`;
    appEl.innerHTML = html;
    return;
  }

  if (!round) {
    html += `<div class="notice info">現在、募集中のラウンドはありません。事務局からの案内をお待ちください。</div>`;
    appEl.innerHTML = html;
    return;
  }

  // 現在のラウンドでの自分の希望提出状況
  const { data: myPref } = await sb
    .from("preferences")
    .select("*, slots(facility_name, department_name)")
    .eq("student_id", student.id)
    .eq("round_id", round.id)
    .order("attempt", { ascending: false })
    .limit(1)
    .maybeSingle();

  html += `<div class="card"><b>現在のラウンド：第${round.round_number}希望</b>`;
  if (round.deadline) {
    html += `<div class="small-muted">提出期限: ${new Date(round.deadline).toLocaleString("ja-JP")}</div>`;
  }
  html += `</div>`;

  if (myPref && myPref.status === "submitted") {
    html += `<div class="notice confirmed">
      ${window.COURSE_LABELS[myPref.course_number-1]}「${esc(myPref.slots.facility_name)} ${esc(myPref.slots.department_name)}」を希望として提出済みです。結果をお待ちください。
    </div>
    <div class="card">
      <button class="secondary small" id="change-btn">希望を変更する</button>
    </div>`;
    appEl.innerHTML = html;
    document.getElementById("change-btn").onclick = () => renderSelection(student, round, remaining, filledCourses, myPref.id, 1);
    return;
  }

  if (myPref && myPref.status === "confirmed") {
    html += `<div class="notice confirmed">このラウンドの希望は確定しました。次のラウンドをお待ちください。</div>`;
    appEl.innerHTML = html;
    return;
  }

  if (myPref && myPref.status === "lost" ) {
    // 2次希望がまだ出せる場合
    const { data: secondPref } = await sb
      .from("preferences")
      .select("*")
      .eq("student_id", student.id)
      .eq("round_id", round.id)
      .eq("attempt", 2)
      .maybeSingle();

    if (!secondPref) {
      html += `<div class="notice warn">第一希望は抽選の結果、埋まってしまいました。空いている枠から2次希望を選んでください。</div>`;
      appEl.innerHTML = html;
      renderSelection(student, round, remaining, filledCourses, null, 2);
      return;
    } else if (secondPref.status === "submitted") {
      html += `<div class="notice confirmed">2次希望を提出済みです。結果をお待ちください。</div>`;
      appEl.innerHTML = html;
      return;
    } else if (secondPref.status === "confirmed") {
      html += `<div class="notice confirmed">2次希望が確定しました。次のラウンドをお待ちください。</div>`;
      appEl.innerHTML = html;
      return;
    } else {
      html += `<div class="notice warn">2次希望も埋まってしまいました。事務局にご相談ください。</div>`;
      appEl.innerHTML = html;
      return;
    }
  }

  appEl.innerHTML = html;
  renderSelection(student, round, remaining, filledCourses, null, 1);
}

async function renderSelection(student, round, remaining, filledCourses, existingPrefId, attempt) {
  const { data: slots } = await sb.from("slots").select("*").eq("active", true);

  // 現ラウンドの希望提出数を集計(このラウンドのattempt=同じattemptのみ集計)
  const { data: prefCounts } = await sb
    .from("preferences")
    .select("slot_id, course_number")
    .eq("round_id", round.id)
    .eq("attempt", attempt)
    .in("status", ["submitted", "lottery", "confirmed"]);

  const countMap = {};
  for (const p of (prefCounts || [])) {
    const key = `${p.slot_id}_${p.course_number}`;
    countMap[key] = (countMap[key] || 0) + 1;
  }

  const availableCourses = [1,2,3,4,5,6].filter(c => !filledCourses.has(c));

  let selHtml = `<div class="card">
    <div class="flex-between">
      <b>クールを選択</b>
    </div>
    <div style="margin:10px 0;">
      <select id="course-select">
        ${availableCourses.map(c => `<option value="${c}">${window.COURSE_LABELS[c-1]}</option>`).join("")}
      </select>
    </div>
    <div id="slot-table-container"></div>
    <div class="flex-between" style="margin-top:12px;">
      <span class="small-muted" id="sel-info">実習先を1つ選んでください</span>
      <button id="submit-btn" disabled>この希望を提出する</button>
    </div>
  </div>`;

  appEl.insertAdjacentHTML("beforeend", selHtml);

  let selectedSlotId = null;

  function renderTable(courseNumber) {
    selectedSlotId = null;
    document.getElementById("submit-btn").disabled = true;
    document.getElementById("sel-info").textContent = "実習先を1つ選んでください";

    const capKey = `cap_${courseNumber}`;
    const eligible = slots.filter(s => {
      if (s[capKey] <= 0) return false;
      if (s.institution_type === "internal" && remaining.internal <= 0) return false;
      if (s.institution_type === "external" && remaining.external <= 0) return false;
      if (s.category === "internal_medicine" && remaining.internal_medicine <= 0) return false;
      if (s.category === "surgery" && remaining.surgery <= 0) return false;
      return true;
    });

    eligible.sort((a,b) => (a.facility_name+a.department_name).localeCompare(b.facility_name+b.department_name, "ja"));

    let rows = eligible.map(s => {
      const cap = s[capKey];
      const cur = countMap[`${s.id}_${courseNumber}`] || 0;
      const overflow = cur >= cap;
      return `<tr class="${overflow ? 'overflow' : ''}" data-id="${s.id}">
        <td><input type="radio" name="slotpick" value="${s.id}" /></td>
        <td>${esc(s.facility_name)}<br/><span class="badge ${s.institution_type==='external'?'ext':''}">${INSTITUTION_LABEL[s.institution_type]}</span> <span class="badge ${s.category==='surgery'?'ext':''}">${CATEGORY_LABEL[s.category]}</span></td>
        <td>${esc(s.department_name)}${s.note ? `<div class="note-text">${esc(s.note.slice(0,80))}${s.note.length>80?'…':''}</div>` : ''}</td>
        <td class="cap">${cur} / ${cap}</td>
      </tr>`;
    }).join("");

    if (!rows) {
      rows = `<tr><td colspan="4" class="small-muted">このクールで選択可能な実習先がありません。</td></tr>`;
    }

    document.getElementById("slot-table-container").innerHTML = `
      <table class="slots">
        <thead><tr><th></th><th>実習先</th><th>診療科</th><th>希望者数/定員</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="small-muted">※「希望者数/定員」は現時点の暫定値です。定員を超えている場合、期限までの話し合い・抽選で調整されます。</p>
    `;

    document.querySelectorAll('input[name="slotpick"]').forEach(el => {
      el.addEventListener("change", (e) => {
        selectedSlotId = e.target.value;
        document.getElementById("submit-btn").disabled = false;
        document.getElementById("sel-info").textContent = "選択済み";
      });
    });
  }

  document.getElementById("course-select").addEventListener("change", (e) => renderTable(Number(e.target.value)));
  if (availableCourses.length > 0) renderTable(availableCourses[0]);

  document.getElementById("submit-btn").addEventListener("click", async () => {
    if (!selectedSlotId) return;
    const courseNumber = Number(document.getElementById("course-select").value);
    const btn = document.getElementById("submit-btn");
    btn.disabled = true;
    btn.textContent = "送信中...";

    if (existingPrefId) {
      const { error } = await sb.from("preferences")
        .update({ slot_id: selectedSlotId, course_number: courseNumber, status: "submitted" })
        .eq("id", existingPrefId);
      if (error) { alert("送信に失敗しました: " + error.message); btn.disabled = false; btn.textContent = "この希望を提出する"; return; }
    } else {
      const { error } = await sb.from("preferences").insert({
        student_id: student.id,
        round_id: round.id,
        slot_id: selectedSlotId,
        course_number: courseNumber,
        attempt: attempt,
        status: "submitted",
      });
      if (error) { alert("送信に失敗しました: " + error.message); btn.disabled = false; btn.textContent = "この希望を提出する"; return; }
    }
    location.reload();
  });
}

main();
