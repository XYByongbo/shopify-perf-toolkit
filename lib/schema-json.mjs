const blank=s=>s.replace(/[^\r\n]/g,' ');
export function parseSchema(s){
 let clean='',inside=false;for(let i=0;i<s.length;i++){const c=s[i];if(inside){clean+=c;if(c==='\\')clean+=s[++i]??'';else if(c==='"')inside=false;}else if(c==='"'){inside=true;clean+=c;}else if(s.startsWith('//',i)){const end=s.indexOf('\n',i);if(end<0)break;clean+=blank(s.slice(i,end));i=end-1;}else if(s.startsWith('/*',i)){const end=s.indexOf('*/',i+2);if(end<0)throw new Error('Unclosed JSON comment');clean+=blank(s.slice(i,end+2));i=end+1;}else clean+=c;}s=clean;
 let out='',quoted=false;for(let i=0;i<s.length;i++){const c=s[i];if(quoted){out+=c;if(c==='\\'){out+=s[++i]??'';}else if(c==='"')quoted=false;}else if(c==='"'){quoted=true;out+=c;}else if(c===','&&/^\s*[}\]]/.test(s.slice(i+1)))out+=' ';else out+=c;}return JSON.parse(out);
}
