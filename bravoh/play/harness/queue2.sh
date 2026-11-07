#!/bin/zsh
cd /Users/ozai/projects/bravoh-lanes/opendaw-spike/native-play-data/harness
V=/Users/ozai/projects/bravoh-lanes/lab-tools/safari/v.sh
free(){ echo "$1 $(date +%H:%M) $($V 'df -m /System/Volumes/Data /Volumes/Lab | tail -2 | awk "{print \$4}" | tr "\n" " "')" >> results/disk.log; }
run(){ free "before $2"; node measure.mjs $1 pass $2 > results/$2.log 2>&1; free "after $2"; }
for i in 1 2; do run safari safari-pass$i; run chromium chromium-pass$i; done
export NOPOLL=1
run safari safari-quiet; run chromium chromium-quiet
echo done
