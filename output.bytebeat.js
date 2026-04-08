//BY NYZXOR.CC 
//discord: p6x6 
 
 t?0:(_SR=11025,_TAU=Math.PI*2,_z=[],_lp=(a,c,id)=>{return _z[id]=(_z[id]??0)+(a-(_z[id]??0))*c},_hp=(a,c,id)=>a-_lp(a,c,id),_bp=(a,lc,hc,id)=>_hp(_lp(a,lc,id),hc,id+500),_nf=(a,lc,hc,id)=>(_lp(a,lc,id)+_hp(a,hc,id+500))/1.5,_lb=(a,c,v,id)=>a+_lp(a,c,id)*v,_hb=(a,c,v,id)=>a+_hp(a,c,id)*v,_si=(f,t)=>Math.sin(t*f*_TAU/_SR),_sa=(f,t)=>(t*f/_SR%1)*2-1,_sq=(f,t)=>(_sa(f,t)>0?1:-1),_tr=(f,t)=>Math.abs(_sa(f,t)*2)-1,_pw=(f,t,d)=>(t*f/_SR%1<d?1:-1),_ns=()=>Math.random()*2-1,_fm=(f,r,ix,t)=>Math.sin(t*f*_TAU/_SR+Math.sin(t*f*r*_TAU/_SR)*ix),_ch=(f,t,dt)=>(_si(f,t)+_si(f*1.005,t+dt))*0.5,_env=(age,dur,at,dc,su,re)=>{if(age<0)return 0;if(age<at)return age/at;if(age<at+dc)return 1-(1-su)*(age-at)/dc;if(age<dur)return su;var rd=age-dur;return rd>re?0:su*(1-rd/re)},_tanh=Math.tanh,_abs=Math.abs,_exp=Math.exp,_sin=Math.sin,_cos=Math.cos,_pow=Math.pow,_clamp=(x,lo,hi)=>Math.max(lo,Math.min(hi,x)),_lerp=(a,b,t)=>a+(b-a)*t,_dcy=(age,rate)=>Math.exp(-age*rate),
_I0=(age,dur,freq,vel,fb)=>{
        var e=_env(age,dur,5,0,1,15),
            s=_si(freq,age)
             +_si(freq*2,age)*0.5
             +_si(freq*3,age)*0.33
             +_si(freq*4,age)*0.15
             +_si(freq*6,age)*0.1
             +_si(freq*8,age)*0.05;
        return _tanh(s*0.48)*e*(vel/127)
    },
_N=[[0,39148,261.6,100,0,0,0.50],
[0,78348,87.3,127,0,20,0.50],
[0,78348,440.0,127,0,40,0.50],
[0,78348,587.3,127,0,60,0.50],
[39199,48999,784.0,127,0,80,0.50],
[39199,78348,261.6,100,0,100,0.50],
[48999,58748,784.0,127,0,120,0.50],
[58799,68548,659.3,127,0,140,0.50],
[68599,78348,523.3,127,0,160,0.50],
[78399,117548,130.8,127,0,180,0.50],
[78399,117548,392.0,127,0,200,0.50],
[78399,117599,65.4,127,0,220,0.50],
[78399,117599,261.6,127,0,240,0.50],
[78399,117599,523.3,127,0,260,0.50],
[117599,156748,49.0,127,0,280,0.50],
[117599,156748,261.6,127,0,300,0.50],
[117599,156748,130.8,127,0,320,0.50],
[117599,156748,196.0,127,0,340,0.50],
[117599,156748,329.6,127,0,360,0.50],
[137199,156748,392.0,127,0,380,0.50],
[146999,156799,523.3,100,0,400,0.50]],
_INSTS=[_I0]),
(()=>{
  var tt=t%156799,L=0,R=0,cnt=0,i,n,s,age;
  for(i=0;i<_N.length;i++){
    n=_N[i];
    if(tt>=n[0]&&tt<n[1]+0&&cnt<24){
      age=tt-n[0];
      s=_clamp(_INSTS[n[4]](age,n[1]-n[0],n[2],n[3],n[5]),-1,1);
      L+=s*(1-n[6]);R+=s*n[6];cnt++
    }
  }
  L=_tanh(L/2)*127+127;
  R=_tanh(R/2)*127+127;
  return [_clamp(L,0,255)|0, _clamp(R,0,255)|0]
})()