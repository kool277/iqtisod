import{F as e,G as t,K as n,P as r,Q as i,T as a,Z as o,b as s,v as c,w as l}from"./index-IC3yyCVU.js";var u=1572864;function d(e){return e.roleName===`Admin`?{sql:`1 = 1`,params:[]}:e.groupId==null?{sql:`1 = 0`,params:[]}:{sql:`t.group_id = ?`,params:[e.groupId]}}function f(e){if(!a(e,l.READ_TRANSACTIONS)&&!a(e,l.READ_DASHBOARD))throw new t}function p(e){return{id:Number(e.id),type:e.type===`INCOME`?`INCOME`:`EXPENSE`,icon:e.icon==null?null:String(e.icon),nameEn:String(e.name_en),nameUzLatn:String(e.name_uz_latn),nameUzCyrl:String(e.name_uz_cyrl),nameRu:String(e.name_ru)}}function m(e){return{id:String(e.id),type:e.type===`INCOME`?`INCOME`:`EXPENSE`,amountMinor:Number(e.amount_minor),currency:String(e.currency),categoryId:Number(e.category_id),userId:String(e.user_id),userEmail:String(e.user_email),groupId:Number(e.group_id),groupName:String(e.group_name),date:String(e.transaction_date),notes:e.notes==null?null:String(e.notes),receiptData:e.receipt_data==null?null:String(e.receipt_data),createdAt:String(e.created_at),updatedAt:String(e.updated_at),nameEn:String(e.name_en),nameUzLatn:String(e.name_uz_latn),nameUzCyrl:String(e.name_uz_cyrl),nameRu:String(e.name_ru)}}function h(e,t){return t===`uz-Latn`?e.nameUzLatn:t===`uz-Cyrl`?e.nameUzCyrl:t===`ru`?e.nameRu:e.nameEn}function g(e){return f(e.user),e.db.query(`SELECT id, name_en, name_uz_latn, name_uz_cyrl, name_ru, type, icon
       FROM categories
       ORDER BY type, id`).map(p)}function _(e,n){if(e.roleName!==`Admin`&&e.groupId!==n)throw new t}function v(e,t){if(t.type!==`INCOME`&&t.type!==`EXPENSE`)throw new n(`TYPE`);if(!s(t.currency))throw new n(`CURRENCY`);let a=r(String(t.amount),t.currency);if(!i(t.date))throw new n(`DATE`);let o=e.db.queryOne(`SELECT id, type FROM categories WHERE id = ?`,[t.categoryId]);if(!o||o.type!==t.type)throw new n(`CATEGORY`);if(e.db.queryValue(`SELECT id FROM groups WHERE id = ?`,[t.groupId])==null)throw new n(`GROUP`);_(e.user,t.groupId);let c=t.notes.trim();if(c.length>2e3)throw new n(`NOTES`);let l=t.receiptData;if(l){if(!l.startsWith(`data:image/`)||l.length>1572864*1.4)throw new n(`RECEIPT_SIZE`)}else l=null;return{type:t.type,currency:t.currency,categoryId:t.categoryId,groupId:t.groupId,date:t.date,amountMinor:a,notes:c,receiptData:l}}function y(e){return{type:e.type,amountMinor:Number(e.amountMinor),currency:e.currency,date:e.date,categoryId:Number(e.categoryId),groupId:Number(e.groupId),notes:e.notes??null}}var b=`SELECT type, amount_minor, currency, transaction_date, category_id, group_id, notes, user_id
  FROM transactions WHERE id = ?`;function x(e){return y({type:e.type,amountMinor:e.amount_minor,currency:e.currency,date:e.transaction_date,categoryId:e.category_id,groupId:e.group_id,notes:e.notes})}var S=`SELECT
  t.id, t.type, t.amount_minor, t.currency, t.category_id, t.user_id, t.group_id,
  t.transaction_date, t.notes, t.receipt_data, t.created_at, t.updated_at,
  c.name_en, c.name_uz_latn, c.name_uz_cyrl, c.name_ru,
  u.email AS user_email, g.name AS group_name
 FROM transactions t
 JOIN categories c ON c.id = t.category_id
 JOIN users u ON u.id = t.user_id
 JOIN groups g ON g.id = t.group_id`;function C(e,n,r=`ALL`){if(!a(e.user,l.READ_TRANSACTIONS))throw new t;let i=d(e.user);return e.db.query(`${S}
     WHERE t.transaction_date >= ? AND t.transaction_date <= ?
       AND ${i.sql}
       AND (? = 'ALL' OR t.type = ?)
     ORDER BY t.transaction_date DESC, t.created_at DESC`,[n.start,n.end,...i.params,r,r]).map(m)}function w(e,n){if(!a(e.user,l.CREATE_TRANSACTION))throw new t;let r=v(e,n),i=crypto.randomUUID(),o=new Date().toISOString();return e.db.withTransaction(()=>{e.db.exec(`INSERT INTO transactions (
         id, type, amount_minor, currency, category_id, user_id, group_id, transaction_date, notes, receipt_data, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,[i,r.type,r.amountMinor,r.currency,r.categoryId,e.user.id,r.groupId,r.date,r.notes||null,r.receiptData,o,o]),c(e.db,e.user.id,`TRANSACTION_CREATED`,`transaction`,i,y(r))}),i}function T(e,r,i){if(!a(e.user,l.UPDATE_TRANSACTION))throw new t;let o=e.db.queryOne(b,[r]);if(!o)throw new n(`REQUIRED`);_(e.user,Number(o.group_id));let s=v(e,i);e.db.withTransaction(()=>{e.db.exec(`UPDATE transactions
       SET type = ?, amount_minor = ?, currency = ?, category_id = ?, group_id = ?, transaction_date = ?,
           notes = ?, receipt_data = ?, updated_at = ?
       WHERE id = ?`,[s.type,s.amountMinor,s.currency,s.categoryId,s.groupId,s.date,s.notes||null,s.receiptData,new Date().toISOString(),r]),c(e.db,e.user.id,`TRANSACTION_UPDATED`,`transaction`,r,{before:x(o),after:y(s)})})}function E(e,r){if(!a(e.user,l.DELETE_TRANSACTION))throw new t;let i=e.db.queryOne(b,[r]);if(!i)throw new n(`REQUIRED`);_(e.user,Number(i.group_id)),e.db.withTransaction(()=>{c(e.db,e.user.id,`TRANSACTION_DELETED`,`transaction`,r,{...x(i),userId:i.user_id}),e.db.exec(`DELETE FROM transactions WHERE id = ?`,[r])})}function D(n,r,i){if(!a(n.user,l.READ_DASHBOARD))throw new t;let s=d(n.user),c=n.currency,u=n.db.queryOne(`SELECT
       COALESCE(SUM(CASE WHEN t.type = 'INCOME' THEN t.amount_minor END), 0) AS income,
       COALESCE(SUM(CASE WHEN t.type = 'EXPENSE' THEN t.amount_minor END), 0) AS expense
     FROM transactions t
     WHERE t.transaction_date >= ? AND t.transaction_date <= ?
       AND t.currency = ?
       AND ${s.sql}`,[r.start,r.end,c,...s.params]),f=Number(u?.income??0),p=Number(u?.expense??0),m=n.db.query(`SELECT substr(t.transaction_date, 1, 7) AS month, t.type AS type, SUM(t.amount_minor) AS total
     FROM transactions t
     WHERE t.transaction_date >= ? AND t.transaction_date <= ?
       AND t.currency = ?
       AND ${s.sql}
     GROUP BY month, t.type
     ORDER BY month`,[r.start,r.end,c,...s.params]),h=o(r.start,r.end),g=h.map(e=>{let t=m.find(t=>t.month===e&&t.type===`INCOME`);return Number(t?.total??0)}),_=h.map(e=>{let t=m.find(t=>t.month===e&&t.type===`EXPENSE`);return Number(t?.total??0)}),v=i===`uz-Latn`?`c.name_uz_latn`:i===`uz-Cyrl`?`c.name_uz_cyrl`:i===`ru`?`c.name_ru`:`c.name_en`,y=n.db.query(`SELECT ${v} AS label, SUM(t.amount_minor) AS total
       FROM transactions t
       JOIN categories c ON c.id = t.category_id
       WHERE t.type = 'EXPENSE'
         AND t.transaction_date >= ? AND t.transaction_date <= ?
         AND t.currency = ?
         AND ${s.sql}
       GROUP BY c.id
       ORDER BY total DESC`,[r.start,r.end,c,...s.params]).map(e=>({label:String(e.label),total:Number(e.total)})),b=n.db.query(`SELECT t.transaction_date AS date, SUM(t.amount_minor) AS total
       FROM transactions t
       WHERE t.type = 'EXPENSE'
         AND t.transaction_date >= ? AND t.transaction_date <= ?
         AND t.currency = ?
         AND ${s.sql}
       GROUP BY t.transaction_date
       ORDER BY t.transaction_date`,[r.start,r.end,c,...s.params]).map(e=>({date:String(e.date),total:Number(e.total)})),x=n.user.roleName===`Admin`?`group`:`user`,S=x===`group`?n.db.query(`SELECT g.name AS label, SUM(t.amount_minor) AS total
           FROM transactions t
           JOIN groups g ON g.id = t.group_id
           WHERE t.type = 'EXPENSE'
             AND t.transaction_date >= ? AND t.transaction_date <= ?
             AND t.currency = ?
             AND ${s.sql}
           GROUP BY g.id
           ORDER BY total DESC`,[r.start,r.end,c,...s.params]):n.db.query(`SELECT u.email AS label, SUM(t.amount_minor) AS total
           FROM transactions t
           JOIN users u ON u.id = t.user_id
           WHERE t.type = 'EXPENSE'
             AND t.transaction_date >= ? AND t.transaction_date <= ?
             AND t.currency = ?
             AND ${s.sql}
           GROUP BY u.id
           ORDER BY total DESC`,[r.start,r.end,c,...s.params]),C=n.db.query(`SELECT t.currency AS currency,
         COALESCE(SUM(CASE WHEN t.type = 'INCOME' THEN t.amount_minor END), 0) AS income,
         COALESCE(SUM(CASE WHEN t.type = 'EXPENSE' THEN t.amount_minor END), 0) AS expense
       FROM transactions t
       WHERE t.transaction_date >= ? AND t.transaction_date <= ?
         AND t.currency <> ?
         AND ${s.sql}
       GROUP BY t.currency
       ORDER BY t.currency`,[r.start,r.end,c,...s.params]).map(e=>({currency:String(e.currency),income:Number(e.income),expense:Number(e.expense)}));return{income:f,expense:p,net:f-p,savingsRate:f>0?e(f-p,f,1):0,months:h,incomeByMonth:g,expenseByMonth:_,categories:y,trend:b,breakdown:S.map(e=>({label:String(e.label),total:Number(e.total)})),breakdownMode:x,otherCurrencies:C}}export{g as a,T as c,E as i,h as n,C as o,w as r,D as s,u as t};