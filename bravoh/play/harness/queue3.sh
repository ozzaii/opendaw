#!/bin/zsh
cd /Users/ozai/projects/bravoh-lanes/opendaw-spike/native-play-data/harness
node lanes.mjs chromium 33 > results/lanes.log 2>&1
echo "after lanes host load $(sysctl -n vm.loadavg)" >> results/hostload.log
export NOPOLL=1
for b in safari chromium; do echo "before $b host load $(sysctl -n vm.loadavg)" >> results/hostload.log; node measure.mjs $b pass $b-quiet2 > results/$b-quiet2.log 2>&1; echo "after $b host load $(sysctl -n vm.loadavg)" >> results/hostload.log; done
echo done
