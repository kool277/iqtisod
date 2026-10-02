import{C as e,d as t,f as n,y as r}from"./money-Dyn0G6Ok.js";import{i,n as a,t as o}from"./rbac-Mji8LhVS.js";import{t as s}from"./limits-D80KQV2n.js";import{rt as c}from"./grant.service-DF-5bqw8.js";import{r as l}from"./audit.service-MrVJMu_j.js";import{F as u,I as d}from"./index-C2UuHW5X.js";var f=[`image/png`,`image/jpeg`,`image/webp`,`image/gif`],p=f.join(`,`),m=/^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/;function h(e,t,n=0){return t.every((t,r)=>e[n+r]===t)}var g=e=>[...e].map(e=>e.charCodeAt(0));function _(e,t){switch(e){case`png`:return h(t,[137,80,78,71,13,10,26,10]);case`jpeg`:return h(t,[255,216,255]);case`gif`:return h(t,g(`GIF87a`))||h(t,g(`GIF89a`));case`webp`:return h(t,g(`RIFF`))&&h(t,g(`WEBP`),8);default:return!1}}function v(e){let t=e.slice(e.indexOf(`,`)+1),n=t.endsWith(`==`)?2:+!!t.endsWith(`=`);return t.length/4*3-n}function y(t){if(t.length>Math.ceil(s.receiptBytes/3)*4+32)throw new e(`RECEIPT_SIZE`);let n=m.exec(t);if(!n||n[2].length%4!=0)throw new e(`RECEIPT_TYPE`);if(v(t)>s.receiptBytes)throw new e(`RECEIPT_SIZE`);let r=Uint8Array.from(atob(n[2].slice(0,16)),e=>e.charCodeAt(0));if(!_(n[1],r))throw new e(`RECEIPT_TYPE`)}var b=s.receiptBytes;function x(e){return i(e)?{sql:`1 = 1`,params:[]}:e.groupId==null?{sql:`1 = 0`,params:[]}:{sql:`t.group_id = ?`,params:[e.groupId]}}function S(e){if(!a(e,o.READ_TRANSACTIONS)&&!a(e,o.READ_DASHBOARD))throw new r}function C(e){return{id:Number(e.id),type:e.type===`INCOME`?`INCOME`:`EXPENSE`,icon:e.icon==null?null:String(e.icon),nameEn:String(e.name_en),nameUzLatn:String(e.name_uz_latn),nameUzCyrl:String(e.name_uz_cyrl),nameRu:String(e.name_ru)}}function w(e){return{id:String(e.id),type:e.type===`INCOME`?`INCOME`:`EXPENSE`,amountMinor:Number(e.amount_minor),currency:String(e.currency),categoryId:Number(e.category_id),userId:String(e.user_id),userEmail:String(e.user_email),groupId:Number(e.group_id),groupName:String(e.group_name),date:String(e.transaction_date),notes:e.notes==null?null:String(e.notes),receiptData:e.receipt_data==null?null:String(e.receipt_data),createdAt:String(e.created_at),updatedAt:String(e.updated_at),nameEn:String(e.name_en),nameUzLatn:String(e.name_uz_latn),nameUzCyrl:String(e.name_uz_cyrl),nameRu:String(e.name_ru)}}function T(e,t){return t===`uz-Latn`?e.nameUzLatn:t===`uz-Cyrl`?e.nameUzCyrl:t===`ru`?e.nameRu:e.nameEn}function E(e){return S(e.user),e.db.query(`SELECT id, name_en, name_uz_latn, name_uz_cyrl, name_ru, type, icon
       FROM categories
       ORDER BY type, id`).map(C)}function D(e,t){if(!i(e)&&e.groupId!==t)throw new r}function O(n,r,i=null){if(r.type!==`INCOME`&&r.type!==`EXPENSE`)throw new e(`TYPE`);if(!c(r.currency))throw new e(`CURRENCY`);let a=t(String(r.amount),r.currency);if(!d(r.date))throw new e(`DATE`);let o=n.db.queryOne(`SELECT id, type FROM categories WHERE id = ?`,[r.categoryId]);if(!o||o.type!==r.type)throw new e(`CATEGORY`);if(n.db.queryValue(`SELECT id FROM groups WHERE id = ?`,[r.groupId])==null)throw new e(`GROUP`);D(n.user,r.groupId);let l=r.notes.trim();if(l.length>s.notesChars)throw new e(`NOTES`);let u=r.receiptData||null;if(u&&u!==i&&(y(u),n.db.sizeBytes()+u.length>s.databaseBudgetBytes))throw new e(`VAULT_FULL`);return{type:r.type,currency:r.currency,categoryId:r.categoryId,groupId:r.groupId,date:r.date,amountMinor:a,notes:l,receiptData:u}}function k(e){return{type:e.type,amountMinor:Number(e.amountMinor),currency:e.currency,date:e.date,categoryId:Number(e.categoryId),groupId:Number(e.groupId),notes:e.notes??null}}var A=`SELECT type, amount_minor, currency, transaction_date, category_id, group_id, notes, user_id
  FROM transactions WHERE id = ?`;function j(e){return k({type:e.type,amountMinor:e.amount_minor,currency:e.currency,date:e.transaction_date,categoryId:e.category_id,groupId:e.group_id,notes:e.notes})}var M=`SELECT
  t.id, t.type, t.amount_minor, t.currency, t.category_id, t.user_id, t.group_id,
  t.transaction_date, t.notes, t.receipt_data, t.created_at, t.updated_at,
  c.name_en, c.name_uz_latn, c.name_uz_cyrl, c.name_ru,
  u.email AS user_email, g.name AS group_name
 FROM transactions t
 JOIN categories c ON c.id = t.category_id
 JOIN users u ON u.id = t.user_id
 JOIN groups g ON g.id = t.group_id`;function N(e,t,n=`ALL`){if(!a(e.user,o.READ_TRANSACTIONS))throw new r;let i=x(e.user);return e.db.query(`${M}
     WHERE t.transaction_date >= ? AND t.transaction_date <= ?
       AND ${i.sql}
       AND (? = 'ALL' OR t.type = ?)
     ORDER BY t.transaction_date DESC, t.created_at DESC`,[t.start,t.end,...i.params,n,n]).map(w)}function P(e,t){if(!a(e.user,o.CREATE_TRANSACTION))throw new r;let n=O(e,t),i=crypto.randomUUID(),s=new Date().toISOString();return e.db.withTransaction(()=>{e.db.exec(`INSERT INTO transactions (
         id, type, amount_minor, currency, category_id, user_id, group_id, transaction_date, notes, receipt_data, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,[i,n.type,n.amountMinor,n.currency,n.categoryId,e.user.id,n.groupId,n.date,n.notes||null,n.receiptData,s,s]),l(e.db,e.user.id,`TRANSACTION_CREATED`,`transaction`,i,k(n))}),i}function F(t,n,i){if(!a(t.user,o.UPDATE_TRANSACTION))throw new r;let s=t.db.queryOne(A,[n]);if(!s)throw new e(`REQUIRED`);D(t.user,Number(s.group_id));let c=t.db.queryValue(`SELECT receipt_data FROM transactions WHERE id = ?`,[n]),u=O(t,i,c==null?null:String(c));t.db.withTransaction(()=>{t.db.exec(`UPDATE transactions
       SET type = ?, amount_minor = ?, currency = ?, category_id = ?, group_id = ?, transaction_date = ?,
           notes = ?, receipt_data = ?, updated_at = ?
       WHERE id = ?`,[u.type,u.amountMinor,u.currency,u.categoryId,u.groupId,u.date,u.notes||null,u.receiptData,new Date().toISOString(),n]),l(t.db,t.user.id,`TRANSACTION_UPDATED`,`transaction`,n,{before:j(s),after:k(u)})})}function I(t,n){if(!a(t.user,o.DELETE_TRANSACTION))throw new r;let i=t.db.queryOne(A,[n]);if(!i)throw new e(`REQUIRED`);D(t.user,Number(i.group_id)),t.db.withTransaction(()=>{l(t.db,t.user.id,`TRANSACTION_DELETED`,`transaction`,n,{...j(i),userId:i.user_id}),t.db.exec(`DELETE FROM transactions WHERE id = ?`,[n])})}function L(t,n){let r=x(t);if(n==null)return r;if(!Number.isSafeInteger(n)||n<=0)throw new e(`GROUP`);return D(t,n),{sql:`(${r.sql}) AND t.group_id = ?`,params:[...r.params,n]}}function R(e,t,s,c=null){if(!a(e.user,o.READ_DASHBOARD))throw new r;let l=L(e.user,c),d=e.currency,f=e.db.queryOne(`SELECT
       COALESCE(SUM(CASE WHEN t.type = 'INCOME' THEN t.amount_minor END), 0) AS income,
       COALESCE(SUM(CASE WHEN t.type = 'EXPENSE' THEN t.amount_minor END), 0) AS expense
     FROM transactions t
     WHERE t.transaction_date >= ? AND t.transaction_date <= ?
       AND t.currency = ?
       AND ${l.sql}`,[t.start,t.end,d,...l.params]),p=Number(f?.income??0),m=Number(f?.expense??0),h=e.db.query(`SELECT substr(t.transaction_date, 1, 7) AS month, t.type AS type, SUM(t.amount_minor) AS total
     FROM transactions t
     WHERE t.transaction_date >= ? AND t.transaction_date <= ?
       AND t.currency = ?
       AND ${l.sql}
     GROUP BY month, t.type
     ORDER BY month`,[t.start,t.end,d,...l.params]),g=u(t.start,t.end),_=g.map(e=>{let t=h.find(t=>t.month===e&&t.type===`INCOME`);return Number(t?.total??0)}),v=g.map(e=>{let t=h.find(t=>t.month===e&&t.type===`EXPENSE`);return Number(t?.total??0)}),y=s===`uz-Latn`?`c.name_uz_latn`:s===`uz-Cyrl`?`c.name_uz_cyrl`:s===`ru`?`c.name_ru`:`c.name_en`,b=e.db.query(`SELECT ${y} AS label, SUM(t.amount_minor) AS total
       FROM transactions t
       JOIN categories c ON c.id = t.category_id
       WHERE t.type = 'EXPENSE'
         AND t.transaction_date >= ? AND t.transaction_date <= ?
         AND t.currency = ?
         AND ${l.sql}
       GROUP BY c.id
       ORDER BY total DESC`,[t.start,t.end,d,...l.params]).map(e=>({label:String(e.label),total:Number(e.total)})),x=e.db.query(`SELECT t.transaction_date AS date, SUM(t.amount_minor) AS total
       FROM transactions t
       WHERE t.type = 'EXPENSE'
         AND t.transaction_date >= ? AND t.transaction_date <= ?
         AND t.currency = ?
         AND ${l.sql}
       GROUP BY t.transaction_date
       ORDER BY t.transaction_date`,[t.start,t.end,d,...l.params]).map(e=>({date:String(e.date),total:Number(e.total)})),S=i(e.user)&&c==null?`group`:`user`,C=S===`group`?e.db.query(`SELECT g.name AS label, SUM(t.amount_minor) AS total
           FROM transactions t
           JOIN groups g ON g.id = t.group_id
           WHERE t.type = 'EXPENSE'
             AND t.transaction_date >= ? AND t.transaction_date <= ?
             AND t.currency = ?
             AND ${l.sql}
           GROUP BY g.id
           ORDER BY total DESC`,[t.start,t.end,d,...l.params]):e.db.query(`SELECT u.email AS label, SUM(t.amount_minor) AS total
           FROM transactions t
           JOIN users u ON u.id = t.user_id
           WHERE t.type = 'EXPENSE'
             AND t.transaction_date >= ? AND t.transaction_date <= ?
             AND t.currency = ?
             AND ${l.sql}
           GROUP BY u.id
           ORDER BY total DESC`,[t.start,t.end,d,...l.params]),w=e.db.query(`SELECT t.currency AS currency,
         COALESCE(SUM(CASE WHEN t.type = 'INCOME' THEN t.amount_minor END), 0) AS income,
         COALESCE(SUM(CASE WHEN t.type = 'EXPENSE' THEN t.amount_minor END), 0) AS expense
       FROM transactions t
       WHERE t.transaction_date >= ? AND t.transaction_date <= ?
         AND t.currency <> ?
         AND ${l.sql}
       GROUP BY t.currency
       ORDER BY t.currency`,[t.start,t.end,d,...l.params]).map(e=>({currency:String(e.currency),income:Number(e.income),expense:Number(e.expense)}));return{income:p,expense:m,net:p-m,savingsRate:p>0?n(p-m,p,1):0,months:g,incomeByMonth:_,expenseByMonth:v,categories:b,trend:x,breakdown:C.map(e=>({label:String(e.label),total:Number(e.total)})),breakdownMode:S,otherCurrencies:w}}export{E as a,x as c,f as d,I as i,F as l,T as n,N as o,P as r,R as s,b as t,p as u};