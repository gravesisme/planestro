/** Read-only reference images are separate from image generation/editing. Manual live probe. */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os'; import { join } from 'node:path'; import { deflateSync } from 'node:zlib';
import { Connection, isolatedCodexHome } from '../packages/server/src/engine/sessions/CodexAppServerPort.ts';
const root=mkdtempSync(join(tmpdir(),'planestro-reference-image-'));
function crc(b:Buffer) { let c=0xffffffff; for(const v of b) { c^=v; for(let k=0;k<8;k++) c=(c>>>1)^((c&1)?0xedb88320:0); } return (c^0xffffffff)>>>0; }
function chunk(type:string,data:Buffer) { const t=Buffer.from(type), n=Buffer.alloc(4), c=Buffer.alloc(4);n.writeUInt32BE(data.length);c.writeUInt32BE(crc(Buffer.concat([t,data])));return Buffer.concat([n,t,data,c]); }
const header=Buffer.alloc(13);header.writeUInt32BE(64,0);header.writeUInt32BE(64,4);header[8]=8;header[9]=2;
const rows=Buffer.alloc(64*(64*3+1));for(let y=0;y<64;y++)for(let x=0;x<64;x++)rows[y*193+1+x*3+2]=255;
const path=join(root,'reference.png');writeFileSync(path,Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]));
const home=isolatedCodexHome(join(root,'home'));const rpc=new Connection('codex',home,home);
const colors:unknown[]=[], types=new Set<string>();let end!:()=>void;const done=new Promise<void>(r=>end=r);
rpc.handler=m=>{const p=m.params??{};if(m.method==='item/completed')types.add(p.item.type);if(m.method==='turn/completed')end();if(m.method==='item/tool/call'){colors.push(p.arguments);void rpc.send({id:m.id,result:{contentItems:[{type:'inputText',text:'Recorded'}],success:true}});}else if(m.id!==undefined&&m.method)void rpc.send({id:m.id,error:{message:'Not permitted in read-only probe'}});};
const timer=setTimeout(end,90000);
try {
 await rpc.request('initialize',{clientInfo:{name:'planestro-reference-validation',version:'1'},capabilities:{experimentalApi:true}});
 await rpc.send({method:'initialized',params:{}});
 const s=await rpc.request('thread/start',{cwd:root,model:'gpt-6-astra',approvalPolicy:'never',sandbox:'read-only',config:{'features.image_generation':false,mcp_servers:{}},dynamicTools:[{type:'function',name:'reference_read',description:'Report the color seen in the attachment',inputSchema:{type:'object',properties:{color:{type:'string'}},required:['color'],additionalProperties:false}}]});
 await rpc.request('turn/start',{threadId:s.thread.id,cwd:root,approvalPolicy:'never',sandboxPolicy:{type:'readOnly',networkAccess:false},input:[{type:'text',text:'Look at the attached image and call reference_read with its dominant color. Do not create or edit an image, read files or run commands. Then finish.',text_elements:[]},{type:'localImage',path}]});
 await Promise.race([done,rpc.closed]);
 console.log(JSON.stringify({stage:'read-only reference image',colors,types:[...types],generationDisabled:true}));
} finally{clearTimeout(timer);await rpc.stop();rmSync(root,{recursive:true,force:true});}

