import { createCampaign, resolveDevice } from '../core/campaign.mjs';
import { getTemplate } from '../core/templates.mjs';
import { invariant } from './errors.js';

const escape=(value:unknown)=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[char]!));
const color=(value:unknown,fallback='#D8DCF0')=>/^#[a-f0-9]{3,8}$/i.test(String(value))?String(value):fallback;

/** A public composition diagram, not a fabricated app or a customer screenshot. */
export function templatePreview(templateId:string) {
  const template=getTemplate(templateId);invariant(template,'TEMPLATE_NOT_FOUND','Template not found.',404);
  if(!template.cloudCompatible)return `<svg xmlns="http://www.w3.org/2000/svg" width="528" height="360" viewBox="0 0 528 360" role="img"><title>${escape(template.name)} — local editor only</title><desc>${escape(template.cloudLimitations.map((item:any)=>item.message).join(' '))}</desc><rect width="528" height="360" rx="20" fill="#202439"/><text x="264" y="166" text-anchor="middle" font-family="sans-serif" font-size="23" fill="#E3E5F6">${escape(template.name)}</text><text x="264" y="200" text-anchor="middle" font-family="sans-serif" font-size="16" fill="#ABAFC9">Preview available in the local editor</text></svg>`;
  const count=Math.min(template.screenCount||1,5);
  const document=(createCampaign as(options:any)=>any)({name:template.name,templateId,templateMode:'exact',screenCount:count,assets:Array.from({length:count},(_,i)=>({id:`preview-${i}`,name:`Screenshot ${i+1}`,width:1320,height:2868}))});
  const w=160,h=w*2868/1320,gap=12,total=count*(w+gap)+gap;
  const parts=[`<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="${h+gap*2}" viewBox="0 0 ${total} ${h+gap*2}" role="img"><title>${escape(template.name)} layout diagram</title><desc>Template positions with generic source placeholders. Upload screenshots to see the finished design.</desc>`];
  document.scenes.forEach((scene:any,i:number)=>{
    const bg=scene.background,stops=bg.gradient?.stops||[],fill=bg.type==='gradient'?`url(#gradient-${i})`:color(bg.solid);
    parts.push(`<defs><clipPath id="scene-${i}"><rect width="${w}" height="${h}" rx="12"/></clipPath><linearGradient id="gradient-${i}" x1="0" y1="0" x2="0" y2="1">${stops.map((stop:any)=>`<stop offset="${Math.max(0,Math.min(100,stop.position))}%" stop-color="${color(stop.color)}"/>`).join('')}</linearGradient></defs><g transform="translate(${gap+i*(w+gap)} ${gap})" clip-path="url(#scene-${i})"><rect width="${w}" height="${h}" fill="${fill}"/>`);
    for(const placement of scene.devices){
      const d=resolveDevice(document,scene.id,placement.id);if(d.hidden)continue;
      const width=w*d.scale/100,height=h*d.scale/100;
      const cx=d.positionMode==='canvas'?w*d.centerX:w/2+(d.x/100-.5)*Math.max(w-width,w*.15);
      const cy=d.positionMode==='canvas'?h*d.centerY:h/2+(d.y/100-.5)*Math.max(h-height,h*.15);
      const sourceIndex=document.sources.findIndex((source:any)=>source.id===d.sourceId);
      const frame=d.frame?.enabled?color(d.frame.color,'#202535'):'none',stroke=d.frame?.enabled?(d.frame.width||0)*width/400:0,radius=(d.cornerRadius||0)*width/400;
      parts.push(`<g transform="translate(${cx} ${cy}) rotate(${d.rotation||0}) matrix(1 ${(d.perspective||0)*.01} 0 1 0 0)" opacity="${(d.opacity??100)/100}"><rect x="${-width/2}" y="${-height/2}" width="${width}" height="${height}" rx="${radius}" fill="${['#F5F3FF','#EEF5F9','#F3F7F0'][Math.max(0,sourceIndex)%3]}" stroke="${frame}" stroke-width="${stroke}"/><text x="0" y="0" text-anchor="middle" font-family="sans-serif" font-size="${Math.max(8,width*.083)}" fill="#68708B">Screenshot ${sourceIndex+1}</text><rect x="${-width*.3}" y="${-height*.3}" width="${width*.6}" height="${height*.12}" rx="${width*.04}" fill="#A4AAC2" opacity=".25"/></g>`);
    }
    const text=scene.text,y=text.position==='bottom'?h*(1-(text.offsetY||6)/100)-26:h*(text.offsetY||7)/100;
    parts.push(`<rect x="${w*.15}" y="${y}" width="${w*.7}" height="7" rx="3.5" fill="${color(text.headlineColor,'#242638')}"/><rect x="${w*.25}" y="${y+12}" width="${w*.5}" height="7" rx="3.5" fill="${color(text.headlineColor,'#242638')}" opacity=".8"/></g>`);
  });
  return parts.join('')+'</svg>';
}
