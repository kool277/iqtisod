import{y as e}from"./money-Dyn0G6Ok.js";import{f as t,n,t as r}from"./rbac-Mji8LhVS.js";var i=1e4;function a(e){return{id:String(e.id),actorId:e.actor_id==null?null:String(e.actor_id),actorEmail:e.actor_email==null?null:String(e.actor_email),action:String(e.action),entityType:e.entity_type==null?null:String(e.entity_type),entityId:e.entity_id==null?null:String(e.entity_id),details:e.details==null?null:String(e.details),createdAt:String(e.created_at)}}var o=`CASE WHEN a.actor_id IS NULL OR u.id IS NOT NULL THEN u.email ELSE (
  SELECT json_extract(d.details, '$.email') FROM audit_logs d
  WHERE d.action = 'USER_DELETED' AND d.entity_type = 'user' AND d.entity_id = a.actor_id AND json_valid(d.details)
  ORDER BY d.seq DESC LIMIT 1) END`;function s(t,s=200){if(!n(t.user,r.READ_AUDIT))throw new e;let c=Number.isSafeInteger(s)?Math.min(Math.max(s,1),i):200;return t.db.query(`SELECT a.id, a.actor_id, ${o} AS actor_email, a.action, a.entity_type, a.entity_id, a.details, a.created_at
     FROM audit_logs a
     LEFT JOIN users u ON u.id = a.actor_id
     ORDER BY a.seq DESC
     LIMIT ?`,[c]).map(a)}function c(i){if(!n(i.user,r.READ_AUDIT))throw new e;return t(i.db)}export{a,s as i,i as n,c as r,o as t};