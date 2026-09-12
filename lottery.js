// ============================================================
// 抽選の共通ロジック（学生ページ・管理画面の両方から呼び出す）
// ============================================================
// 期限を過ぎていて、まだ処理されていないラウンドがあれば自動で抽選を実行する。
// 複数人が同時にページを開いても二重実行されないよう、
// phase を「処理中」に更新できた人だけが実際の処理を担当する（楽観的ロック）。
window.tryRunLotteryIfDue = async function (sb, round) {
  if (!round || !round.course_number) return round;
  const now = new Date();

  let phaseToProcess = null;
  if (round.phase === "first_choice" && round.end_at && now > new Date(round.end_at)) {
    phaseToProcess = "first_choice";
  } else if (round.phase === "second_match" && round.second_deadline && now > new Date(round.second_deadline)) {
    phaseToProcess = "second_match";
  }
  if (!phaseToProcess) return round;

  const lockPhase = phaseToProcess + "_processing";
  const { data: locked } = await sb
    .from("rounds")
    .update({ phase: lockPhase })
    .eq("id", round.id)
    .eq("phase", phaseToProcess)
    .select();

  if (!locked || locked.length === 0) {
    // 他の人がすでに処理中、または処理済み。最新状態を取り直す
    const { data: fresh } = await sb.from("rounds").select("*").eq("id", round.id).maybeSingle();
    return fresh || round;
  }

  await window.runLotteryCore(sb, round, phaseToProcess);

  const { data: fresh } = await sb.from("rounds").select("*").eq("id", round.id).maybeSingle();
  return fresh || round;
};

// 実際の抽選処理本体（施設全体の人数上限も考慮したグローバル抽選）
window.runLotteryCore = async function (sb, round, phaseToProcess) {
  const attempt = phaseToProcess === "second_match" ? 2 : 1;
  const courseNumber = round.course_number;

  const { data: prefs } = await sb
    .from("preferences")
    .select("id, student_id, slot_id, status, slots(cap_1,cap_2,cap_3,cap_4,cap_5,cap_6, facility_name)")
    .eq("round_id", round.id)
    .eq("attempt", attempt)
    .eq("status", "submitted");

  const { data: facilityLimits } = await sb.from("facility_limits").select("*");
  const limitMap = {};
  (facilityLimits || []).forEach(f => { limitMap[f.facility_name] = f.max_total; });

  const shuffled = (prefs || []).slice().sort(() => Math.random() - 0.5);
  const slotCount = {};
  const facilityCount = {};
  let confirmedCount = 0, lostCount = 0;

  for (const p of shuffled) {
    const cap = p.slots["cap_" + courseNumber];
    const fname = p.slots.facility_name;
    const curSlot = slotCount[p.slot_id] || 0;
    const curFac = facilityCount[fname] || 0;
    const facLimit = limitMap[fname];

    if (curSlot < cap && (!facLimit || curFac < facLimit)) {
      await sb.from("preferences").update({ status: "confirmed" }).eq("id", p.id);
      await sb.from("assignments").upsert(
        { student_id: p.student_id, course_number: courseNumber, slot_id: p.slot_id },
        { onConflict: "student_id,course_number" }
      );
      slotCount[p.slot_id] = curSlot + 1;
      facilityCount[fname] = curFac + 1;
      confirmedCount++;
    } else {
      await sb.from("preferences").update({ status: "lost" }).eq("id", p.id);
      lostCount++;
    }
  }

  const nextPhase = phaseToProcess === "first_choice"
    ? (lostCount > 0 ? "second_match" : "closed")
    : "closed"; // 2次マッチング後は締める（さらに残った人は次のラウンドで別途拾う）

  await sb.from("rounds").update({ phase: nextPhase }).eq("id", round.id);

  return { confirmedCount, lostCount, nextPhase };
};
