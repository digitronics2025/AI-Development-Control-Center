import { HttpError } from '../http.js';

/** D1 Free permits 50 statements/invocation. Reserve headroom and leave work
 * durable for the next tick, rather than assuming batch() counts as one query. */
export class QueryBudget {
  used=0;
  rowsRead=0;
  rowsWritten=0;
  private record(result:unknown):void{
    if(!result||typeof result!=='object'||!('meta' in result)||!result.meta||typeof result.meta!=='object')return;
    if('rows_read' in result.meta&&typeof result.meta.rows_read==='number')this.rowsRead+=result.meta.rows_read;
    if('rows_written' in result.meta&&typeof result.meta.rows_written==='number')this.rowsWritten+=result.meta.rows_written;
  }
  readonly limit=48;
  get remaining():number{return this.limit-this.used;}
  private take(count:number):void{
    if(count>this.remaining)throw new HttpError(429,'OPS_QUERY_LIMIT','Bounded operations query limit reached; pending work remains durable.');
    this.used+=count;
  }
  wrap(db:D1Database):D1Database{
    const originals=new WeakMap<D1PreparedStatement,D1PreparedStatement>();
    const statement=(raw:D1PreparedStatement):D1PreparedStatement=>{
      const proxy=new Proxy(raw,{get:(target,key)=>{
        if(key==='bind')return (...args:unknown[])=>statement(target.bind(...args));
        if(key==='first')return async (column?:string)=>{
          // all() exposes D1's actual row accounting; first() discards meta.
          // These statements are PK/unique/bounded reads or bounded RETURNING.
          this.take(1);const result=await target.all<Record<string,unknown>>();this.record(result);
          const row=result.results[0];return row?(column?row[column]??null:row):null;
        };
        if(['all','run','raw'].includes(String(key)))return async (...args:unknown[])=>{
          this.take(1);const result=await Reflect.apply(Reflect.get(target,key),target,args);
          this.record(result);return result;
        };
        return Reflect.get(target,key);
      }});
      originals.set(proxy,raw);return proxy;
    };
    return new Proxy(db,{get:(target,key)=>{
      if(key==='prepare')return (sql:string)=>statement(target.prepare(sql));
      if(key==='batch')return async (values:D1PreparedStatement[])=>{this.take(values.length);const results=await target.batch(values.map(v=>originals.get(v)??v));for(const r of results)this.record(r);return results;};
      if(key==='exec'||key==='withSession')throw new HttpError(403,'OPS_UNBOUNDED_QUERY','Operations use prepared bounded statements only.');
      return Reflect.get(target,key);
    }});
  }
}
