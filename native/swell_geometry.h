// SwellGeometry.js numerical geometry in a persistent packed world. Source
// topology, geometric branch selection and finite-difference trials all run on
// the browser CPU here. No allocations or JS calls occur during evaluation.
extern "C" double sin(double), cos(double), atan2(double, double), fmod(double, double), hypot(double, double), floor(double);
namespace swell {
constexpr double eps=1e-8, tau=6.283185307179586476925286766559;
struct V { double x,y; };
static V add(V a,V b){return {a.x+b.x,a.y+b.y};}
static V sub(V a,V b){return {a.x-b.x,a.y-b.y};}
static V scale(V a,double s){return {a.x*s,a.y*s};}
static V mid(V a,V b){return scale(add(a,b),.5);}
static double dot(V a,V b){return a.x*b.x+a.y*b.y;}
static double cross(V a,V b){return a.x*b.y-a.y*b.x;}
static double len(V a){return hypot(a.x,a.y);}
static double dist(V a,V b){return len(sub(a,b));}
static V left(V a){return {-a.y,a.x};}
static V right(V a){return {a.y,-a.x};}
static bool valid(V a){return finite(a.x)&&finite(a.y);}
static V bad(){return {__builtin_nan(""),__builtin_nan("")};}
static V unit(V a){double m=len(a);return m>eps?scale(a,1/m):bad();}
static double angle(V a){return atan2(a.y,a.x);}
static double norm(double a){return fmod(a+tau,tau);}
static V polar(V c,double r,double a){return add(c,{r*cos(a),r*sin(a)});}
static V transform(V p,const double* f,bool inverse=false){
  double c=cos(f[2]),s=sin(f[2]);
  if(inverse){p=sub(p,{f[0],f[1]});return {c*p.x+s*p.y,-s*p.x+c*p.y};}
  return {c*p.x-s*p.y+f[0],s*p.x+c*p.y+f[1]};
}
struct Source { i32 type,ref,count,group,closed,compositeClosed,definition,segment,segments,piece,capacity,sample,samples,endpoint,suppressStart,suppressEnd,frame[3]; };
static_assert(sizeof(Source)==19*sizeof(i32));
struct Definition {double offset,swell,start,end,direction,enabled;};
struct Piece { i32 type,segment,role,ordinal,point,count; V start,end,middle,center; double radius; bool ccw; };
struct Line {i32 owner,index; V start,end,tangent,normal,baseStart,baseEnd; bool valid;};
struct State {V center,cycle; double radius; bool ccw,hasCycle; i32 pieces;};
struct Request {i32 source,segment,role,ordinal,index,midpoint,anchor,global,frame[3];};
static i32 sourceCount,refCount,definitionCount,pairCount,requestCount,segmentCount,sampleCount,numberCount;
static i32* integers;static double *numbers,*previousNumbers,*previousCoordinates,*results;
static Source* sources;static i32 *refs,*pairs;static Request* requests;static Definition* definitions;
static V *points,*samples,*shiftStart,*shiftEnd;
static Line* lines;static Piece* pieces;static State* states;
static i32 *parents,*visited,*parentNode,*parentEdge,*depth,*walk,*cursorEdge,*path,*groupEntries;
static bool cached=false;
static double* displayPieces;
static void allocate(i32 entities,i32 references,i32 defs,i32 joins,i32 queries,i32 segments,i32 sampled){
  sourceCount=entities;refCount=references;definitionCount=defs;pairCount=joins;requestCount=queries;segmentCount=segments;sampleCount=sampled;
  const i32 integerCount=entities*19+references+joins*3+queries*11;
  numberCount=entities*6+defs*6+queries*4;
  integers=reserve<i32>(integerCount);numbers=reserve<double>(numberCount);previousNumbers=reserve<double>(numberCount);
  previousCoordinates=reserve<double>(references);results=reserve<double>(queries*12);
  sources=reinterpret_cast<Source*>(integers);refs=integers+entities*19;pairs=refs+references;requests=reinterpret_cast<Request*>(pairs+joins*3);
  definitions=reinterpret_cast<Definition*>(numbers+entities*6);
  points=reserve<V>(references);samples=reserve<V>(sampled);shiftStart=reserve<V>(sampled);shiftEnd=reserve<V>(sampled);
  lines=reserve<Line>(segments);pieces=reserve<Piece>(segments*3+entities);states=reserve<State>(entities);
  displayPieces=reserve<double>((segments*3+entities)*18);
  parents=reserve<i32>(entities*2);visited=reserve<i32>(entities*2);parentNode=reserve<i32>(entities*2);parentEdge=reserve<i32>(entities*2);
  depth=reserve<i32>(entities*2);walk=reserve<i32>(entities*2);cursorEdge=reserve<i32>(entities*2);path=reserve<i32>(entities*2);groupEntries=reserve<i32>(entities*2);
  cached=false;
}
static V sourcePoint(i32 i,i32 at){return points[sources[i].ref+at];}
static V endpoint(i32 key){auto& s=sources[key/2];return sourcePoint(key/2,key%2?s.count-1:0);}
static V readPoint(i32 ref,const double* frame){return transform({x[refs[ref]],x[refs[ref+1]]},frame);}
static void readSources(){
  for(i32 i=0;i<sourceCount;++i){
    const auto& s=sources[i];const double* f=numbers+i*6;auto& state=states[i];state={};
    if(s.type==2){
      V start=readPoint(s.ref,f),center=readPoint(s.ref+2,f),end=readPoint(s.ref+4,f);
      // Binding arcMetrics computes radii and angles in local coordinates.
      V localStart={x[refs[s.ref]],x[refs[s.ref+1]]},localCenter={x[refs[s.ref+2]],x[refs[s.ref+3]]},localEnd={x[refs[s.ref+4]],x[refs[s.ref+5]]};
      double a=angle(sub(localStart,localCenter)),delta=norm(angle(sub(localEnd,localCenter))-a),span=f[4]?delta:-(tau-delta);
      state.center=center;state.radius=(dist(localStart,localCenter)+dist(localEnd,localCenter))/2;state.ccw=f[4]!=0;
      points[s.ref]=start;points[s.ref+1]=transform(polar(localCenter,state.radius,a+span*f[3]),f);points[s.ref+2]=end;
    }else if(s.type==3){points[s.ref]=readPoint(s.ref,f);state.center=points[s.ref];state.radius=absd(x[refs[s.ref+2]]);}
    else for(i32 k=0;k<s.count;++k)points[s.ref+k]=readPoint(s.ref+k*2,f);
  }
}
static i32 find(i32 i){i32 r=i;while(parents[r]!=r)r=parents[r];while(parents[i]!=r){i32 next=parents[i];parents[i]=r;i=next;}return r;}
static void join(i32 a,i32 b){if(sources[a/2].endpoint&&sources[b/2].endpoint)parents[find(b)]=find(a);}
static void cycle(i32 node,i32 ancestor,i32 closing){
  i32 count=0,current=node;while(current!=ancestor){if(parentEdge[current]<0)return;path[count++]=parentEdge[current];current=parentNode[current];}
  V center={0,0};i32 total=0;
  for(i32 k=count-1;k>=-1;--k){i32 e=k>=0?path[k]:closing;for(i32 p=0;p<sources[e].count;++p){center=add(center,sourcePoint(e,p));++total;}}
  if(!total)return;center=scale(center,1.0/total);
  for(i32 k=0;k<count;++k){states[path[k]].cycle=center;states[path[k]].hasCycle=true;}
  states[closing].cycle=center;states[closing].hasCycle=true;
}
static void topology(){
  for(i32 i=0;i<sourceCount*2;++i){parents[i]=i;visited[i]=0;parentNode[i]=parentEdge[i]=-1;depth[i]=0;}
  for(i32 a=0;a<sourceCount*2;++a)if(sources[a/2].endpoint)
    for(i32 b=a+1;b<sourceCount*2;++b)if(sources[b/2].endpoint&&dist(endpoint(a),endpoint(b))<=1e-6)join(a,b);
  for(i32 k=0;k<pairCount;++k)join(pairs[k*3],pairs[k*3+1]);
  // Match the JS DFS cycle order without using the C++ call stack.
  for(i32 key=0;key<sourceCount*2;++key){
    if(!sources[key/2].endpoint)continue;i32 root=find(key);if(visited[root])continue;
    i32 top=0;walk[0]=root;cursorEdge[0]=0;visited[root]=1;
    while(top>=0){
      i32 node=walk[top],edge=cursorEdge[top]++;
      if(edge>=sourceCount){--top;continue;}
      if(!sources[edge].endpoint)continue;i32 a=find(edge*2),b=find(edge*2+1);
      if(a!=node&&b!=node)continue;
      i32 other=a==node?b:a;
      if(a==b){cycle(node,node,edge);continue;}
      if(!visited[other]){parentNode[other]=node;parentEdge[other]=edge;depth[other]=depth[node]+1;visited[other]=1;walk[++top]=other;cursorEdge[top]=0;continue;}
      if(parentEdge[node]!=edge&&depth[other]<depth[node])cycle(node,other,edge);
    }
  }
}
static V intersection(V a0,V a1,V b0,V b1){
  V a=sub(a1,a0),b=sub(b1,b0);double d=cross(a,b);if(absd(d)<=eps)return bad();
  return add(a0,scale(a,cross(sub(b0,a0),b)/d));
}
static i32 lineCircle(V a,V b,V center,double radius,V* out){
  V direction=sub(b,a),from=sub(a,center);double aa=dot(direction,direction);if(aa<=eps)return 0;
  double bb=2*dot(from,direction),cc=dot(from,from)-radius*radius,d=bb*bb-4*aa*cc;if(d< -eps)return 0;
  double r=root(maxd(0,d)),t0=(-bb-r)/(2*aa),t1=(-bb+r)/(2*aa);
  out[0]=add(a,scale(direction,t0));out[1]=add(a,scale(direction,t1));return t0==t1?1:2;
}
static i32 circleCircle(V a,double ar,V b,double br,V* out){
  V delta=sub(b,a);double d=len(delta);if(d<=eps||d>ar+br+eps||d<absd(ar-br)-eps)return 0;
  double along=(ar*ar-br*br+d*d)/(2*d),h=ar*ar-along*along;if(h< -eps)return 0;
  V base=add(a,scale(delta,along/d)),perp=scale(left(delta),root(maxd(0,h))/d);
  out[0]=h<=eps?base:add(base,perp);out[1]=sub(base,perp);return h<=eps?1:2;
}
static V nearest(V* candidates,i32 count,V target,V fallback){
  V result=fallback;double best=__builtin_inf();for(i32 i=0;i<count;++i){double d=dist(candidates[i],target);if(i==0||d<best){result=candidates[i];best=d;}}return result;
}
static V onCircle(V center,V p,double radius){V direction=unit(sub(p,center));return valid(direction)?add(center,scale(direction,radius)):p;}
static Piece makeLine(V a,V b){Piece p={};p.type=1;p.start=a;p.end=b;return p;}
static Piece tangentArc(V start,V end,V tangent,bool atEnd){
  V normal=left(tangent),p=atEnd?end:start,delta=sub(atEnd?start:end,p);double d=2*dot(delta,normal);
  if(absd(d)<=eps)return makeLine(start,end);
  V center=add(p,scale(normal,dot(delta,delta)/d));double radius=dist(center,p);if(!finite(radius)||radius<=eps)return makeLine(start,end);
  V radial=sub(p,center);bool ccw=dot(left(radial),tangent)>=dot(right(radial),tangent);
  double a=angle(sub(start,center)),b=angle(sub(end,center)),span=ccw?norm(b-a):-norm(a-b);
  Piece piece={};piece.type=2;piece.start=start;piece.end=end;piece.center=center;piece.radius=radius;piece.ccw=ccw;piece.middle=polar(center,radius,a+span/2);return piece;
}
static void push(i32 owner,Piece piece,i32 segment,i32 role,i32 ordinal){
  const auto& s=sources[owner];if(states[owner].pieces>=s.capacity)return;
  piece.segment=segment;piece.role=role;piece.ordinal=ordinal;pieces[s.piece+states[owner].pieces++]=piece;
}
static V centroid(i32 owner){
  auto& s=sources[owner];if(states[owner].hasCycle)return states[owner].cycle;
  V center={0,0};i32 count=0;
  for(i32 i=0;i<sourceCount;++i)if((s.group>=0?sources[i].group==s.group:i==owner)&&sources[i].segments){
    for(i32 k=0;k<sources[i].segments;++k){center=add(center,sourcePoint(i,k));center=add(center,sourcePoint(i,(k+1)%sources[i].count));count+=2;}
  }
  return count?scale(center,1.0/count):bad();
}
static void descriptors(){
  for(i32 i=0;i<sourceCount;++i){
    auto& s=sources[i];auto& state=states[i];
    for(i32 j=0;j<s.segments;++j){
      auto& line=lines[s.segment+j];auto& d=definitions[s.definition+j];
      line.owner=i;line.index=j;line.start=sourcePoint(i,j);line.end=sourcePoint(i,(j+1)%s.count);
      line.tangent=unit(sub(line.end,line.start));line.valid=valid(line.tangent);line.normal=right(line.tangent);
      if(state.hasCycle||s.compositeClosed||s.type==5){V center=centroid(i);if(valid(center)&&dot(line.normal,sub(mid(line.start,line.end),center))<0)line.normal=scale(line.normal,-1);}
      if(d.direction<0)line.normal=scale(line.normal,-1);
      double effective=d.enabled?maxd(d.offset,d.swell):d.offset;
      line.baseStart=add(line.start,scale(line.normal,s.suppressStart?effective:d.offset));
      line.baseEnd=add(line.end,scale(line.normal,s.suppressEnd?effective:d.offset));
    }
    if(s.type==2){
      auto& d=definitions[s.definition];double radial=state.ccw?1:-1;
      V middle=sourcePoint(i,1);
      if(state.hasCycle)radial=dot(sub(middle,state.center),sub(middle,state.cycle))>=0?1:-1;
      double offset=numbers[i*6+5]?d.direction*(d.enabled?maxd(d.offset,d.swell):d.offset):radial*d.direction*d.offset;
      Piece piece={};piece.type=2;piece.center=state.center;piece.radius=maxd(eps,state.radius+offset);piece.ccw=state.ccw;
      piece.start=onCircle(state.center,sourcePoint(i,0),piece.radius);piece.end=onCircle(state.center,sourcePoint(i,2),piece.radius);
      piece.middle=onCircle(state.center,middle,piece.radius);push(i,piece,-1,0,0);
    }
  }
}
// Offset joins precede transition construction. Multi-segment legacy endpoint
// lookups intentionally select the last segment, matching SwellGeometry.js.
struct OffsetEnd {i32 owner,line;bool end,arc;};
static OffsetEnd offsetEnd(i32 key){auto& s=sources[key/2];return {key/2,s.segment+s.segments-1,key%2!=0,s.type==2};}
static bool validEnd(OffsetEnd e){return e.arc?states[e.owner].pieces>0:sources[e.owner].segments>0&&lines[e.line].valid;}
static V offsetPoint(OffsetEnd e){if(e.arc){auto& p=pieces[sources[e.owner].piece];return e.end?p.end:p.start;}auto& l=lines[e.line];return e.end?l.baseEnd:l.baseStart;}
static V originalPoint(OffsetEnd e){if(e.arc)return sourcePoint(e.owner,e.end?2:0);auto& l=lines[e.line];return e.end?l.end:l.start;}
static void setOffset(OffsetEnd e,V point){if(e.arc){auto& p=pieces[sources[e.owner].piece];if(e.end)p.end=point;else p.start=point;}else{auto& l=lines[e.line];if(e.end)l.baseEnd=point;else l.baseStart=point;}}
static void joinOffset(OffsetEnd a,OffsetEnd b){
  if(!validEnd(a)||!validEnd(b)||(a.arc==b.arc&&(a.arc?a.owner==b.owner:a.line==b.line)))return;
  V candidates[2];i32 count=0;
  if(!a.arc&&!b.arc){auto& x=lines[a.line];auto& y=lines[b.line];V p=intersection(x.baseStart,x.baseEnd,y.baseStart,y.baseEnd);if(valid(p)){candidates[0]=p;count=1;}}
  else if(a.arc&&b.arc){auto& x=pieces[sources[a.owner].piece];auto& y=pieces[sources[b.owner].piece];count=circleCircle(x.center,x.radius,y.center,y.radius,candidates);}
  else{auto& l=lines[a.arc?b.line:a.line];auto& arc=pieces[sources[a.arc?a.owner:b.owner].piece];count=lineCircle(l.baseStart,l.baseEnd,arc.center,arc.radius,candidates);}
  V p=nearest(candidates,count,mid(originalPoint(a),originalPoint(b)),mid(offsetPoint(a),offsetPoint(b)));setOffset(a,p);setOffset(b,p);
}
static void offsetJoins(){
  for(i32 i=0;i<pairCount;++i)if(pairs[i*3+2])joinOffset(offsetEnd(pairs[i*3]),offsetEnd(pairs[i*3+1]));
  for(i32 i=0;i<sourceCount;++i){auto& s=sources[i];if(s.type!=4&&s.type!=5)continue;
    for(i32 j=0;j<s.segments;++j){i32 next=j+1<s.segments?j+1:s.closed?0:-1;if(next>=0)joinOffset({i,s.segment+j,true,false},{i,s.segment+next,false,false});}}
}
static void linePieces(){
  for(i32 i=0;i<segmentCount;++i){
    auto& l=lines[i];if(!l.valid)continue;auto& s=sources[l.owner];auto& d=definitions[s.definition+l.index];
    double available=dist(l.start,l.end),start=s.suppressStart?0:d.direction<0?d.end:d.start,end=s.suppressEnd?0:d.direction<0?d.start:d.end,total=start+end;
    bool enabled=true;if(total>available+eps){if(total<=eps||total*.5>available+eps){enabled=false;start=end=0;}else{double ratio=available/total;start*=ratio;end*=ratio;}}
    if(!d.enabled||d.swell<=d.offset+eps||!enabled){push(l.owner,makeLine(l.baseStart,l.baseEnd),l.index,0,0);continue;}
    V a=s.suppressStart?l.baseStart:add(add(l.start,scale(l.tangent,start)),scale(l.normal,d.swell));
    V b=s.suppressEnd?l.baseEnd:add(add(l.end,scale(l.tangent,-end)),scale(l.normal,d.swell));
    i32 ordinal=0;if(!s.suppressStart)push(l.owner,tangentArc(l.baseStart,a,l.tangent,true),l.index,1,ordinal++);
    if(dist(a,b)>eps)push(l.owner,makeLine(a,b),l.index,2,ordinal++);
    if(!s.suppressEnd)push(l.owner,tangentArc(b,l.baseEnd,l.tangent,false),l.index,3,ordinal++);
  }
}
static void roundAndCurves(){
  for(i32 i=0;i<sourceCount;++i){
    auto& s=sources[i];auto& d=definitions[s.definition];if(states[i].pieces)continue;
    if(s.type==3){Piece p={};p.type=3;p.center=states[i].center;p.radius=maxd(eps,states[i].radius+d.direction*d.offset);push(i,p,-1,0,0);}
    if(s.type!=6||s.samples<2)continue;
    i32 at=s.sample;
    for(i32 k=0;k<s.count-1;++k){
      V a=sourcePoint(i,k),b=sourcePoint(i,k+1),previous=sourcePoint(i,k>0?k-1:0),after=sourcePoint(i,k+2<s.count?k+2:s.count-1);
      V ca=add(a,scale(sub(b,previous),.18)),cb=add(b,scale(sub(a,after),.18));
      for(i32 j=k==0?0:1;j<=16;++j){double t=j/16.0,u=1-t;samples[at++]={u*u*u*a.x+3*u*u*t*ca.x+3*u*t*t*cb.x+t*t*t*b.x,u*u*u*a.y+3*u*u*t*ca.y+3*u*t*t*cb.y+t*t*t*b.y};}
    }
    for(i32 k=0;k<s.samples-1;++k){V a=samples[s.sample+k],b=samples[s.sample+k+1],normal=right(unit(sub(b,a)));
      if(states[i].hasCycle&&dot(normal,sub(mid(a,b),states[i].cycle))<0)normal=scale(normal,-1);
      shiftStart[s.sample+k]=add(a,scale(normal,d.direction*d.offset));shiftEnd[s.sample+k]=add(b,scale(normal,d.direction*d.offset));}
    for(i32 k=0;k<s.samples;++k){
      bool previous=k>0&&valid(shiftEnd[s.sample+k-1]),next=k<s.samples-1&&valid(shiftStart[s.sample+k]);
      V p=samples[s.sample+k];
      if(previous&&next){p=intersection(shiftStart[s.sample+k-1],shiftEnd[s.sample+k-1],shiftStart[s.sample+k],shiftEnd[s.sample+k]);if(!valid(p))p=mid(shiftEnd[s.sample+k-1],shiftStart[s.sample+k]);}
      else if(previous)p=shiftEnd[s.sample+k-1];else if(next)p=shiftStart[s.sample+k];samples[s.sample+k]=p;
    }
    Piece p={};p.type=4;p.point=s.sample;p.count=s.samples;push(i,p,-1,0,0);
  }
}
static Piece* terminal(i32 key){auto& s=sources[key/2];i32 count=states[key/2].pieces;return count?pieces+s.piece+(key%2?count-1:0):nullptr;}
static V terminalPoint(Piece* p,bool end){if(!p)return bad();if(p->type==1||p->type==2)return end?p->end:p->start;if(p->type==4&&p->count)return samples[p->point+(end?p->count-1:0)];return bad();}
static bool terminalLine(Piece* p,bool end,V* out){if(p->type==1){out[0]=p->start;out[1]=p->end;return true;}if(p->type==4&&p->count>=2){i32 k=p->point+(end?p->count-2:0);out[0]=samples[k];out[1]=samples[k+1];return true;}return false;}
static void setTerminal(i32 key,V point){Piece* p=terminal(key);if(!p)return;if(p->type==1||p->type==2){if(key%2)p->end=point;else p->start=point;}else if(p->type==4&&p->count)samples[p->point+(key%2?p->count-1:0)]=point;}
static V joinedTerminal(i32 first,i32 second){
  Piece* a=terminal(first);Piece* b=terminal(second);V ap=terminalPoint(a,first%2),bp=terminalPoint(b,second%2);
  if(!valid(ap)||!valid(bp))return bad();if(dist(ap,bp)<=eps)return ap;
  V candidates[2],lineA[2],lineB[2];i32 count=0;
  if(a->type==2&&b->type==2)count=circleCircle(a->center,a->radius,b->center,b->radius,candidates);
  else if(a->type==2||b->type==2){Piece* arc=a->type==2?a:b;if(terminalLine(a->type==2?b:a,(a->type==2?second:first)%2,lineA))count=lineCircle(lineA[0],lineA[1],arc->center,arc->radius,candidates);}
  else if(terminalLine(a,first%2,lineA)&&terminalLine(b,second%2,lineB)){V p=intersection(lineA[0],lineA[1],lineB[0],lineB[1]);if(valid(p)){candidates[0]=p;count=1;}}
  return nearest(candidates,count,mid(endpoint(first),endpoint(second)),mid(ap,bp));
}
static void terminalJoins(){
  for(i32 i=0;i<sourceCount*2;++i)visited[i]=0;
  for(i32 key=0;key<sourceCount*2;++key){
    if(!sources[key/2].endpoint)continue;i32 group=find(key);if(visited[group])continue;visited[group]=1;i32 count=0;
    for(i32 k=0;k<sourceCount*2;++k)if(sources[k/2].endpoint&&find(k)==group&&terminal(k))groupEntries[count++]=k;
    if(count<2)continue;V p={0,0};
    if(count==2)p=joinedTerminal(groupEntries[0],groupEntries[1]);
    else{for(i32 k=0;k<count;++k)p=add(p,terminalPoint(terminal(groupEntries[k]),groupEntries[k]%2));p=scale(p,1.0/count);}
    if(valid(p))for(i32 k=0;k<count;++k)setTerminal(groupEntries[k],p);
  }
}
static bool circleThrough(Piece& p){
  V a=p.start,b=p.middle,c=p.end;double d=2*(a.x*(b.y-c.y)+b.x*(c.y-a.y)+c.x*(a.y-b.y));if(absd(d)<1e-10)return false;
  double aa=dot(a,a),bb=dot(b,b),cc=dot(c,c);p.center={(aa*(b.y-c.y)+bb*(c.y-a.y)+cc*(a.y-b.y))/d,(aa*(c.x-b.x)+bb*(a.x-c.x)+cc*(b.x-a.x))/d};return true;
}
static void resolveRequests(){
  for(i32 q=0;q<requestCount;++q){
    const auto& r=requests[q];const auto& s=sources[r.source];const double* f=numbers+sourceCount*6+definitionCount*6+q*4;
    double* out=results+q*12;for(i32 k=0;k<12;++k)out[k]=__builtin_nan("");
    Piece* found=nullptr;for(i32 k=0;k<states[r.source].pieces;++k){Piece* p=pieces+s.piece+k;if(p->segment==r.segment&&p->role==r.role&&p->ordinal==r.ordinal){found=p;break;}}
    if(!found)continue;Piece p=*found;V point=bad(),a=bad(),b=bad();double span=0;
    if(p.type==1){p.start=transform(p.start,f,true);p.end=transform(p.end,f,true);if(r.index==0){a=p.start;b=p.end;}point=r.index==0?p.start:r.index==2?p.end:r.index==1?mid(p.start,p.end):bad();}
    if(p.type==2){
      p.start=transform(p.start,f,true);p.end=transform(p.end,f,true);p.middle=transform(p.middle,f,true);p.center=transform(p.center,f,true);
      if(!(valid(p.center)&&finite(p.radius)&&absd(p.radius)>eps)&&!circleThrough(p))continue;
      double start=angle(sub(p.start,p.center)),end=angle(sub(p.end,p.center)),middle=angle(sub(p.middle,p.center)),delta=norm(end-start);
      p.ccw=norm(middle-start)<=delta;span=p.ccw?delta:-(tau-delta);
      double traveled=p.ccw?norm(middle-start):norm(start-middle),ratio=absd(span)>1e-9?maxd(.05,mind(.95,traveled/absd(span))):.5;
      p.radius=(dist(p.start,p.center)+dist(p.end,p.center))/2;
      point=r.midpoint||r.index==1?polar(p.center,p.radius,start+span*(r.midpoint?.5:ratio)):r.index==0?p.start:r.index==2?p.end:r.index==3?p.center:bad();
    }
    if(p.type==3){p.center=transform(p.center,f,true);p.radius=maxd(eps,p.radius);V d[5]={{0,0},{-1,0},{0,-1},{1,0},{0,1}};if(r.index>=0&&r.index<5)point=add(p.center,scale(d[r.index],p.radius));}
    if(p.type==4){if(r.index>=0&&r.index<p.count)point=transform(samples[p.point+r.index],f,true);if(r.index>=0&&r.index<p.count-1){a=point;b=transform(samples[p.point+r.index+1],f,true);}}
    if(r.anchor==1)point=(p.type==2||p.type==3)?p.center:bad();
    if(r.anchor==2)point=a;if(r.anchor==3)point=b;if(r.anchor==4)point=add(a,scale(sub(b,a),f[3]));
    if(p.type==2){a=p.start;b=p.end;}
    if(r.global){point=transform(point,f);a=transform(a,f);b=transform(b,f);p.center=transform(p.center,f);}
    out[0]=a.x;out[1]=a.y;out[2]=b.x;out[3]=b.y;
    if(p.type==2||p.type==3){out[4]=p.center.x;out[5]=p.center.y;out[6]=p.radius;out[7]=p.ccw;}
    if(p.type==2)out[8]=span;
    out[9]=point.x;out[10]=point.y;out[11]=p.type;
  }
}
static void evaluate(){
  for(i32 i=0;i<sourceCount;++i)for(i32 k=0;k<3;++k)if(sources[i].frame[k]>=0)numbers[i*6+k]=x[sources[i].frame[k]];
  for(i32 i=0;i<requestCount;++i)for(i32 k=0;k<3;++k)if(requests[i].frame[k]>=0)numbers[sourceCount*6+definitionCount*6+i*4+k]=x[requests[i].frame[k]];
  bool same=cached;
  if(same)for(i32 i=0;i<refCount;++i)if(previousCoordinates[i]!=x[refs[i]]){same=false;break;}
  if(same)for(i32 i=0;i<numberCount;++i)if(previousNumbers[i]!=numbers[i]){same=false;break;}
  if(same)return;
  for(i32 i=0;i<refCount;++i)previousCoordinates[i]=x[refs[i]];copy(previousNumbers,numbers,numberCount);
  readSources();topology();descriptors();offsetJoins();linePieces();roundAndCurves();terminalJoins();resolveRequests();cached=true;
}
static double value(i32 query,i32 field){evaluate();return results[query*12+field];}
}
extern "C" __attribute__((visibility("default"))) i32 swell_export(){
  using namespace swell;evaluate();i32 count=0;
  for(i32 i=0;i<sourceCount;++i)for(i32 k=0;k<states[i].pieces;++k){
    const auto& p=pieces[sources[i].piece+k];double* out=displayPieces+count++*18;
    const double start=angle(sub(sourcePoint(i,0),states[i].center)),end=sources[i].type==2?angle(sub(sourcePoint(i,2),states[i].center)):start;
    const bool major=sources[i].type==2&&(states[i].ccw?norm(end-start):norm(start-end))>tau/2;
    const double data[]={static_cast<double>(i),static_cast<double>(p.segment),static_cast<double>(p.role),static_cast<double>(p.ordinal),static_cast<double>(p.type),
      p.start.x,p.start.y,p.end.x,p.end.y,p.middle.x,p.middle.y,p.center.x,p.center.y,p.radius,static_cast<double>(p.ccw),static_cast<double>(p.point),static_cast<double>(p.count),static_cast<double>(major)};
    copy(out,data,18);
  }
  return count;
}
extern "C" __attribute__((visibility("default"))) u32 swell_export_buffer(i32 kind){return reinterpret_cast<u32>(kind==0?static_cast<void*>(swell::displayPieces):static_cast<void*>(swell::samples));}
