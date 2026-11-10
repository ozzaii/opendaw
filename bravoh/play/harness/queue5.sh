#!/bin/zsh
V=/Users/ozai/projects/bravoh-lanes/lab-tools/safari/v.sh; K=gva8kLmC3cZ70OKGagGJmXL2md5EQ6iMEiyBlJLBQ6Q; T=native-play-native-play-native-play-local
cd /Users/ozai/projects/bravoh-lanes/opendaw-spike/native-play-data/harness/results
for i in 1 2; do
 echo "wk engine $i $(date +%H:%M) host $(sysctl -n vm.loadavg)" >> hostload.log
 $V "echo admin | sudo -S launchctl asuser 501 sudo -u admin /Volumes/Lab/np/wkpass 'http://localhost:7791/booth/#key=$K&token=$T&measureoff=1' 216 2>/dev/null" > wk-engine$i.log 2>&1
 echo "wk control $i $(date +%H:%M) host $(sysctl -n vm.loadavg)" >> hostload.log
 $V "echo admin | sudo -S launchctl asuser 501 sudo -u admin /Volumes/Lab/np/wkpass 'http://localhost:7791/booth/#key=$K&token=$T&gesture=1&control=1' 216 control 2>/dev/null" > wk-control$i.log 2>&1
done
echo "done wk $(date +%H:%M) host $(sysctl -n vm.loadavg)" >> hostload.log
