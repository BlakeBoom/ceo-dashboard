// Role hierarchy: admin > exco > campaign_lead > tm > agent
// admin and exco both see all campaign data; only admin reaches the settings
// (rules / user management) endpoints.
export const ROLE_RANK = { agent: 0, tm: 1, campaign_lead: 2, exco: 3, admin: 4 };

// Sees every campaign's data (no row scoping).
export function seesAllScope(user) {
  return user.role === 'admin' || user.role === 'exco';
}

export function hasRole(user, minRole) {
  return ROLE_RANK[user.role] >= ROLE_RANK[minRole];
}

export function requireRole(minRole) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'unauthenticated' });
    if (!hasRole(req.user, minRole)) return res.status(403).json({ error: 'forbidden' });
    next();
  };
}

// Scope check: can `user` view records belonging to (campaignId, teamId)?
// admin/exco → everything. campaign_lead → own campaign. tm → own team. agent → only own user_id.
export function canViewScope(user, { campaignId = null, teamId = null, userId = null } = {}) {
  if (seesAllScope(user)) return true;
  if (user.role === 'campaign_lead') {
    return campaignId == null || campaignId === user.campaign_id;
  }
  if (user.role === 'tm') {
    if (teamId != null) return teamId === user.team_id;
    if (campaignId != null) return campaignId === user.campaign_id;
    return false;
  }
  // agent
  if (userId != null) return userId === user.id;
  return false;
}

// Returns the WHERE-clause fragment + params to inject into queries to enforce scope server-side.
// Usage: const { sql, params } = scopeClause(req.user, { campaignCol: 'b.campaign_id', teamCol: 'u.team_id', userCol: 'u.id' });
export function scopeClause(user, { campaignCol, teamCol, userCol }, startParamIdx = 1) {
  if (seesAllScope(user)) return { sql: 'TRUE', params: [], nextIdx: startParamIdx };
  if (user.role === 'campaign_lead') {
    return { sql: `${campaignCol} = $${startParamIdx}`, params: [user.campaign_id], nextIdx: startParamIdx + 1 };
  }
  if (user.role === 'tm') {
    return { sql: `${teamCol} = $${startParamIdx}`, params: [user.team_id], nextIdx: startParamIdx + 1 };
  }
  return { sql: `${userCol} = $${startParamIdx}`, params: [user.id], nextIdx: startParamIdx + 1 };
}
