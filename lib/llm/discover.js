/**
 * 竞品发现 · 状态机（v1.6 · grilling 风格 frontier）
 * ------------------------------------------------------------
 * 流程：
 *   1. 用户提交初始想法 → firstFrontier(userIdea) → 输出 frontier Q's
 *   2. 用户回答一组 Q → 状态机重算 frontier：
 *      - 若 frontier 空 → generateCandidates()
 *      - 若 frontier 非空 → nextFrontier()
 *   3. 用户主动说"够了"或 3 轮未收敛 → 强制 generateCandidates()
 *
 * 状态保存在 DB.conversations 表（含 history_json = 历轮 Q&A 回放），
 * 前端不持有状态，断线重连可恢复。
 *
 * API：
 *   startConversation({ userIdea }) → { conversationId, frontierQuestions, specSummary, round, askedIds }
 *   answerQuestions({ conversationId, answers }) → 同上（如果 ready=true 则额外含 candidates）
 *   skipConversation(conversationId) → 立即出候选
 */

const { chat } = require('./client');
const {
  DISCOVERY_SYSTEM,
  buildDiscoveryFrontierPrompt,
  CANDIDATES_SYSTEM,
  buildCandidatesPrompt,
} = require('./prompts');

const MAX_ROUNDS = 3;

/**
 * 启动一次发现会话
 */
async function startConversation({ userIdea, db }) {
  if (!userIdea || !userIdea.trim()) throw new Error('userIdea 不能为空');
  const conversationId = db.createConversation({ userIdea });

  const frontier = await _computeFrontier({
    userIdea,
    history: [],
    round: 1,
  });

  db.updateConversation(conversationId, {
    spec_summary: frontier.spec_summary,
    round: frontier.round,
    frontier_json: JSON.stringify(frontier),
    asked_ids_json: JSON.stringify([]),
    answers_json: JSON.stringify({}),
    history_json: JSON.stringify([]),
    ready: frontier.ready ? 1 : 0,
  });

  return {
    conversationId,
    ready: frontier.ready,
    round: frontier.round,
    specSummary: frontier.spec_summary,
    askedIds: [],
    answers: {},
    history: [],
    frontierQuestions: frontier.frontier_questions,
    gapsRemaining: frontier.gaps_remaining,
  };
}

/**
 * 用户提交一轮答案
 * @param {string} conversationId
 * @param {object} answers  { qid: answer_text }
 */
async function answerQuestions({ conversationId, answers, db }) {
  const conv = db.getConversation(conversationId);
  if (!conv) throw new Error('conversation 不存在');
  if (conv.ready) {
    return _buildFinalResponse(conv, db);
  }

  const prevHistory = JSON.parse(conv.history_json || '[]');
  const prevAnswers = JSON.parse(conv.answers_json || '{}');
  const prevFrontier = JSON.parse(conv.frontier_json || '{}');

  // 把这一轮的 Q&A 追加到 history
  const prevQuestions = prevFrontier.frontier_questions || [];
  const newHistoryRound = {
    round: conv.round,
    questions: prevQuestions,
    answers,
  };
  const newHistory = [...prevHistory, newHistoryRound];
  const newAnswers = { ...prevAnswers, ...answers };
  const newAskedIds = [
    ...(JSON.parse(conv.asked_ids_json || '[]')),
    ...prevQuestions.map(q => q.id),
  ];

  const nextRound = conv.round + 1;

  let frontier;
  if (nextRound > MAX_ROUNDS) {
    // 强制收敛 → 出候选
    frontier = { ready: true, round: nextRound, frontier_questions: [], gaps_remaining: [] };
  } else {
    try {
      frontier = await _computeFrontier({
        userIdea: conv.user_idea,
        history: newHistory,
        round: nextRound,
      });
    } catch (e) {
      console.error('frontier 计算失败:', e.message);
      // 软失败：保留上一轮 frontier 不动，让用户能再试
      throw e; // frontier 失败仍需要报错，因为没有 frontier 用户就没法继续
    }
  }

  let candidates = null;
  let candidatesError = null;
  if (frontier.ready) {
    try {
      candidates = await _generateCandidates({
        userIdea: conv.user_idea,
        specSummary: frontier.spec_summary,
        answers: newAnswers,
      });
    } catch (e) {
      // 候选生成失败不要炸 — 让用户能重试或补充信息
      console.error('candidates 生成失败:', e.message);
      candidatesError = e.message;
      // 把 frontier 退回未就绪 + 在 specSummary 里附带错误提示，让前端知道发生了什么
      frontier = { ...frontier, ready: false, frontier_questions: [], gaps_remaining: [], spec_summary: (frontier.spec_summary || '') + '\n\n（候选生成失败：' + e.message + '，请重新回答一些问题或点「够了」重试）' };
    }
  }

  db.updateConversation(conversationId, {
    spec_summary: frontier.spec_summary,
    round: frontier.round,
    frontier_json: JSON.stringify(frontier),
    asked_ids_json: JSON.stringify(newAskedIds),
    answers_json: JSON.stringify(newAnswers),
    history_json: JSON.stringify(newHistory),
    ready: frontier.ready ? 1 : 0,
    candidates_json: candidates ? JSON.stringify(candidates) : null,
  });

  const updated = {
    ...conv,
    spec_summary: frontier.spec_summary,
    round: frontier.round,
    ready: frontier.ready ? 1 : 0,
    frontier_json: JSON.stringify(frontier),
    asked_ids_json: JSON.stringify(newAskedIds),
    answers_json: JSON.stringify(newAnswers),
    history_json: JSON.stringify(newHistory),
    candidates_json: candidates ? JSON.stringify(candidates) : null,
  };
  return _buildFinalResponse(updated, db);
}

/**
 * 用户跳过：立刻出候选
 */
async function skipConversation({ conversationId, db }) {
  const conv = db.getConversation(conversationId);
  if (!conv) throw new Error('conversation 不存在');
  const answers = JSON.parse(conv.answers_json || '{}');

  const candidates = await _generateCandidates({
    userIdea: conv.user_idea,
    specSummary: conv.spec_summary || '（用户跳过澄清，按通用竞品分析处理）',
    answers,
  });

  db.updateConversation(conversationId, {
    ready: 1,
    candidates_json: JSON.stringify(candidates),
  });

  return _buildFinalResponse({ ...conv, ready: 1, candidates_json: JSON.stringify(candidates) }, db);
}

/**
 * 调 LLM 计算 frontier
 */
async function _computeFrontier({ userIdea, history, round }) {
  const messages = [
    { role: 'system', content: DISCOVERY_SYSTEM },
    { role: 'user', content: buildDiscoveryFrontierPrompt({ userIdea, frontierHistory: history, round }) },
  ];
  const res = await chat({ messages, temperature: 0.5, maxTokens: 1500, jsonMode: true });
  const parsed = _extractJson(res.text);
  if (!parsed) throw new Error(`LLM 返回无法解析: ${String(res.text).slice(0, 200)}`);
  return {
    ready: !!parsed.ready,
    round: parsed.round || round,
    spec_summary: parsed.spec_summary || '',
    frontier_questions: parsed.frontier_questions || [],
    gaps_remaining: parsed.gaps_remaining || [],
  };
}

/**
 * 调 LLM 生成候选清单
 */
async function _generateCandidates({ userIdea, specSummary, answers }) {
  const messages = [
    { role: 'system', content: CANDIDATES_SYSTEM },
    { role: 'user', content: buildCandidatesPrompt({ userIdea, specSummary, answers }) },
  ];
  const res = await chat({ messages, temperature: 0.6, maxTokens: 2000, jsonMode: true });
  const parsed = _extractJson(res.text);
  if (!parsed) throw new Error(`候选生成失败: ${String(res.text).slice(0, 200)}`);
  // 后置：URL 校验，标记无效的 url（不是 http(s)://xxx.yyy 形式 → 标 url_invalid）
  const rawCandidates = parsed.candidates || [];
  const validated = rawCandidates.map((c) => {
    const u = (c.url || '').trim();
    const looksLikeUrl = /^https?:\/\/[^\s]+\.[^\s]+/.test(u);
    return { ...c, url_invalid: !looksLikeUrl };
  });
  return {
    candidates: validated,
    dismissed_alternatives: parsed.dismissed_alternatives || [],
    research_notes: parsed.research_notes || '',
  };
}

// ---- 工具函数 ----

function _extractJson(text) {
  if (text && typeof text === 'object') return text;
  let s = (text || '').trim();
  if (typeof s !== 'string') return null;
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  try { return JSON.parse(s); } catch { return null; }
}

function _buildFinalResponse(conv, db) {
  return {
    conversationId: conv.id,
    ready: !!conv.ready,
    round: conv.round,
    specSummary: conv.spec_summary,
    askedIds: JSON.parse(conv.asked_ids_json || '[]'),
    answers: JSON.parse(conv.answers_json || '{}'),
    history: JSON.parse(conv.history_json || '[]'),
    frontierQuestions: (JSON.parse(conv.frontier_json || '{}').frontier_questions) || [],
    candidates: conv.candidates_json ? JSON.parse(conv.candidates_json).candidates : null,
    dismissedAlternatives: conv.candidates_json ? JSON.parse(conv.candidates_json).dismissed_alternatives : null,
    researchNotes: conv.candidates_json ? JSON.parse(conv.candidates_json).research_notes : null,
  };
}

module.exports = {
  startConversation,
  answerQuestions,
  skipConversation,
};