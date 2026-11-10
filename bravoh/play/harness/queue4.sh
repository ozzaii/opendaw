#!/bin/zsh
cd /Users/ozai/projects/bravoh-lanes/opendaw-spike/native-play-data/harness
for b in chromium safari; do echo "$b fresh $(date +%H:%M) host $(sysctl -n vm.loadavg)" >> results/hostload.log; FRESH=1 node measure.mjs $b pass $b-fresh > results/$b-fresh.log 2>&1; done
export NOPOLL=1
for i in 1 2; do
 echo "control $i $(date +%H:%M) host $(sysctl -n vm.loadavg)" >> results/hostload.log; CONTROL=1 node measure.mjs safari pass safari-control$i > results/safari-control$i.log 2>&1
 echo "engine $i $(date +%H:%M) host $(sysctl -n vm.loadavg)" >> results/hostload.log; node measure.mjs safari pass safari-quiet3$i > results/safari-quiet3$i.log 2>&1
done
echo done $(date +%H:%M) host $(sysctl -n vm.loadavg) >> results/hostload.log
