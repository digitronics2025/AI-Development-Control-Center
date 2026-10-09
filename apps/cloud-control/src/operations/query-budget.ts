import { HttpError } from '../http.js';

/** D1 Free permits 50 statements/invocation. Reserve headroom and leave work
 * durable for the next tick, rather than assuming batch() counts as one query. */
export class QueryBudget {
  used=0;
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
        if(['first','all','run','raw'].includes(String(key)))return (...args:unknown[])=>{
          this.take(1);return Reflect.apply(Reflect.get(target,key),target,args);
        };
        return Reflect.get(target,key);
      }});
      originals.set(proxy,raw);return proxy;
    };
    return new Proxy(db,{get:(target,key)=>{
      if(key==='prepare')return (sql:string)=>statement(target.prepare(sql));
      if(key==='batch')return (values:D1PreparedStatement[])=>{this.take(values.length);return target.batch(values.map(v=>originals.get(v)??v));};
      if(key==='exec'||key==='withSession')throw new HttpError(403,'OPS_UNBOUNDED_QUERY','Operations use prepared bounded statements only.');
      return Reflect.get(target,key);
    }});
  }
}
