export async function seedAccounts(db: D1Database): Promise<void> {
  const now = new Date().toISOString()
  await db.prepare('INSERT INTO organizations (id,name) VALUES (?,?)').bind('org-a', 'Organization A').run()
  for (const [id, role] of [['administrator', 'administrator'], ['operator-a', 'operator'], ['reviewer-a1', 'reviewer'], ['reviewer-a2', 'reviewer'], ['reviewer-b1', 'reviewer'], ['team-user-a', 'team_user']]) {
    await db.prepare('INSERT INTO users (id,email,password_hash,salt,organization_id,name,role,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').bind(id, `${id}@example.test`, '', '', 'org-a', id, role, now, now).run()
    await db.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,0,?,?)').bind(id, id, `${id}@example.test`, now, now).run()
    await db.prepare("INSERT INTO identities VALUES (?,'local','local',?,?)").bind(id, id, now).run()
    await db.prepare('INSERT INTO memberships VALUES (?,?,?)').bind(id, 'org-a', role).run()
  }
}
