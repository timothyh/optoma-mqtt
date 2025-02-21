#!/bin/bash

useradd -r -G dialout,video,input nodejs

cp -p optoma-mqtt.service /etc/systemd/system/
systemctl daemon-reload

npm install

echo "Now review/create a config.json file"
echo "To enable the service run:"
echo "    systemctl enable --now optoma-mqtt.service"
