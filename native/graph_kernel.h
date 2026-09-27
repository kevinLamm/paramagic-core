// Each graph kernel has its own WASM instance and retains its packed capacity.
namespace graph {
static i32 *offsets,*edges,*parents,*weights, variables,nodes,capacityV,capacityN,capacityE;
static i32 find(i32 value){i32 root=value;while(parents[root]!=root)root=parents[root];while(parents[value]!=root){i32 next=parents[value];parents[value]=root;value=next;}return root;}
}
extern "C" __attribute__((visibility("default"))) i32 graph_configure(i32 variables,i32 nodes,i32 edges) {
  if(variables<0||variables>2000000||nodes<0||nodes>2000000||edges<0||edges>16000000)return 0;
  graph::variables=variables;graph::nodes=nodes;
  if(variables<=graph::capacityV&&nodes<=graph::capacityN&&edges<=graph::capacityE&&graph::offsets)return 1;
  graph::capacityV=maxd(variables,graph::capacityV*2);graph::capacityN=maxd(nodes,graph::capacityN*2);graph::capacityE=maxd(edges,graph::capacityE*2);
  cursor=reinterpret_cast<u32>(&__heap_base);
  graph::offsets=reserve<i32>(graph::capacityN+1);graph::edges=reserve<i32>(graph::capacityE);
  graph::parents=reserve<i32>(graph::capacityV);graph::weights=reserve<i32>(graph::capacityV);
  const u32 current=__builtin_wasm_memory_size(0),required=(cursor+65535)/65536;
  if(required<=current||__builtin_wasm_memory_grow(0,required-current)!=static_cast<unsigned long>(-1))return 1;
  graph::capacityV=graph::capacityN=graph::capacityE=0;graph::offsets=nullptr;return 0;
}
extern "C" __attribute__((visibility("default"))) u32 graph_buffer(i32 kind){return reinterpret_cast<u32>(kind==0?graph::offsets:kind==1?graph::edges:graph::parents);}
extern "C" __attribute__((visibility("default"))) void graph_components(){
  using namespace graph;
  for(i32 i=0;i<variables;++i){parents[i]=i;weights[i]=1;}
  for(i32 c=0;c<nodes;++c)for(i32 e=offsets[c]+1;e<offsets[c+1];++e){
    i32 a=find(edges[offsets[c]]),b=find(edges[e]);if(a==b)continue;
    if(weights[a]<weights[b]){i32 t=a;a=b;b=t;}parents[b]=a;weights[a]+=weights[b];
  }
  for(i32 i=0;i<variables;++i)parents[i]=find(i);
}
