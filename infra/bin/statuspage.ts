#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { AppStack } from '../lib/app-stack';
import { DatabaseStack } from '../lib/database-stack';
import { NetworkStack } from '../lib/network-stack';
import { parseAllowedCidrs } from '../lib/allowed-cidrs';

const app = new App();
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: 'ap-southeast-2',
};
const allowedCidrs = parseAllowedCidrs(app.node.tryGetContext('allowedCidrs'));

// Phase 2〜4 の構築を寿命ごとに分け、毎日の App 削除で DB を巻き込まない。
const network = new NetworkStack(app, 'StatuspageNetwork', { env });
const database = new DatabaseStack(app, 'StatuspageDatabase', {
  env,
  vpc: network.vpc,
  dbSecurityGroup: network.dbSecurityGroup,
});
new AppStack(app, 'StatuspageApp', {
  env,
  vpc: network.vpc,
  dbSecurityGroup: network.dbSecurityGroup,
  database: database.instance,
  allowedCidrs,
});
