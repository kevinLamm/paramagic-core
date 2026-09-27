namespace continuation {
static i32 count,capacity;static double *input,*current,*previous,*checkpoint;static i32* active;
}
extern "C" __attribute__((visibility("default"))) i32 continuation_configure(i32 count){
  using namespace continuation;if(count<0||count>2000000)return 0;continuation::count=count;
  if(input&&count<=capacity)return 1;capacity=maxd(count,capacity*2);cursor=reinterpret_cast<u32>(&__heap_base);
  input=reserve<double>(capacity);current=reserve<double>(capacity);previous=reserve<double>(capacity);checkpoint=reserve<double>(capacity);continuation::active=reserve<i32>(capacity);
  const u32 pages=__builtin_wasm_memory_size(0),required=(cursor+65535)/65536;
  if(required<=pages||__builtin_wasm_memory_grow(0,required-pages)!=static_cast<unsigned long>(-1))return 1;
  capacity=0;input=nullptr;return 0;
}
extern "C" __attribute__((visibility("default"))) u32 continuation_buffer(i32 kind){return reinterpret_cast<u32>(kind==0?static_cast<void*>(continuation::input):static_cast<void*>(continuation::active));}
extern "C" __attribute__((visibility("default"))) void continuation_reset(){using namespace continuation;copy(current,input,count);copy(previous,input,count);}
extern "C" __attribute__((visibility("default"))) void continuation_accept(){using namespace continuation;copy(previous,current,count);copy(current,input,count);}
extern "C" __attribute__((visibility("default"))) void continuation_checkpoint(){using namespace continuation;copy(checkpoint,input,count);}
extern "C" __attribute__((visibility("default"))) void continuation_restore(){using namespace continuation;copy(input,checkpoint,count);}
extern "C" __attribute__((visibility("default"))) void continuation_predict(double ratio){
  using namespace continuation;
  for(i32 i=0;i<count;++i)if(continuation::active[i]){const double delta=(current[i]-previous[i])*ratio;if(finite(delta)&&absd(delta)>1e-12)input[i]=current[i]+delta;}
}
