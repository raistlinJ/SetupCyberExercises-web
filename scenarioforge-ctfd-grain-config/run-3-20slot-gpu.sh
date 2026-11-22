#!/bin/bash
# Dr. Jaime C. Acosta
# 20 slots per GPU, with 8,192 context tokens per slot (20 * 8192 = 163840).

# Default values
MODEL_PATH="/mnt/disk021/hfmodels/Qwen3.5-9B-Q4_K_M.gguf"
ALIAS="qwen3.5-9b"

# Parse CLI arguments
while getopts "m:a:" opt; do
  case ${opt} in
    m ) MODEL_PATH=$OPTARG ;;
    a ) ALIAS=$OPTARG ;;
    \? ) echo "Usage: $0 [-m model_path] [-a alias]"
         exit 1 ;;
  esac
done

# 1. Verify model file exists
if [ ! -f "$MODEL_PATH" ]; then
  echo "❌ Error: Model file not found at '$MODEL_PATH'" >&2
  exit 1
fi

mkdir -p llama-logs

for gpu_index in 0 1 2; do
  server_port=$((11434 + gpu_index))
  log_file="llama-logs/gpu-${gpu_index}.log"
  pid_file="llama-logs/gpu-${gpu_index}.pid"

  # 2. Check if port is already bound
  if ss -tlnp | grep -q ":$server_port "; then
    echo "⚠️ Warning: Port $server_port is already in use. Skipping GPU $gpu_index." >&2
    continue
  fi

  echo "🚀 Launching llama-server on GPU $gpu_index (Port $server_port; 20 slots, 8192 context tokens per slot)..."
  
  nohup env CUDA_VISIBLE_DEVICES="$gpu_index" llama-server \
    -m "$MODEL_PATH" \
    --alias "$ALIAS" \
    -ngl 99 -t 8 -tb 8 \
    -np 20 -c 163840 -b 2048 -ub 512 \
    --jinja --chat-template-kwargs '{"enable_thinking":false}' \
    --metrics --host 0.0.0.0 --port "$server_port" \
    > "$log_file" 2>&1 < /dev/null &
  
  server_pid=$!
  echo $server_pid > "$pid_file"

  # 3. Quick startup validation (Wait 2 seconds and check if process is still alive)
  sleep 2
  if ! kill -0 $server_pid 2>/dev/null; then
    echo "❌ GPU $gpu_index failed to start! Recent logs from $log_file:" >&2
    tail -n 15 "$log_file" >&2
    echo "--------------------------------------------------------" >&2
  else
    echo "✅ GPU $gpu_index process is running (PID: $server_pid). Confirm n_ctx_slot = 8192 and readiness in $log_file."
  fi
done
