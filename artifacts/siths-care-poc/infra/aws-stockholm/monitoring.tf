resource "aws_sns_topic" "alarms" {
  name              = "${var.name}-alarms"
  kms_master_key_id = aws_kms_key.data.id
}

resource "aws_sns_topic_subscription" "email" {
  count     = var.alarm_email == null ? 0 : 1
  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

locals {
  alarm_actions = [aws_sns_topic.alarms.arn]
  alb_suffix    = aws_lb.this.arn_suffix
  tg_suffix     = aws_lb_target_group.app.arn_suffix
}

resource "aws_cloudwatch_metric_alarm" "healthy_hosts" {
  alarm_name          = "${var.name}-no-healthy-hosts"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HealthyHostCount"
  dimensions          = { LoadBalancer = local.alb_suffix, TargetGroup = local.tg_suffix }
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 2
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "alb_5xx" {
  alarm_name          = "${var.name}-alb-5xx"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_ELB_5XX_Count"
  dimensions          = { LoadBalancer = local.alb_suffix }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 5
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "latency" {
  alarm_name          = "${var.name}-latency"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "TargetResponseTime"
  dimensions          = { LoadBalancer = local.alb_suffix, TargetGroup = local.tg_suffix }
  extended_statistic  = "p95"
  period              = 300
  evaluation_periods  = 2
  threshold           = 2
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "ecs_running" {
  alarm_name          = "${var.name}-ecs-running-tasks"
  namespace           = "ECS/ContainerInsights"
  metric_name         = "RunningTaskCount"
  dimensions          = { ClusterName = aws_ecs_cluster.this.name, ServiceName = aws_ecs_service.app.name }
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 2
  threshold           = var.desired_count
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = local.alarm_actions
}

locals {
  dynamodb_alarms = {
    auth_throttle  = { table = aws_dynamodb_table.auth.name, metric = "ThrottledRequests" }
    audit_throttle = { table = aws_dynamodb_table.audit.name, metric = "ThrottledRequests" }
    auth_errors    = { table = aws_dynamodb_table.auth.name, metric = "SystemErrors" }
    audit_errors   = { table = aws_dynamodb_table.audit.name, metric = "SystemErrors" }
  }
}

resource "aws_cloudwatch_metric_alarm" "dynamodb" {
  for_each            = local.dynamodb_alarms
  alarm_name          = "${var.name}-dynamodb-${each.key}"
  namespace           = "AWS/DynamoDB"
  metric_name         = each.value.metric
  dimensions          = { TableName = each.value.table }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
}

resource "aws_cloudwatch_log_metric_filter" "auth_failures" {
  name           = "${var.name}-auth-failures"
  log_group_name = aws_cloudwatch_log_group.app.name
  pattern        = "{ $.category = \"siths_auth\" && $.result = \"rejected\" }"
  metric_transformation {
    name      = "AuthenticationFailures"
    namespace = "SithsCarePilot/Security"
    value     = "1"
  }
}

resource "aws_cloudwatch_log_metric_filter" "security_events" {
  name           = "${var.name}-security-events"
  log_group_name = aws_cloudwatch_log_group.app.name
  pattern        = "{ ($.reasonCode = \"TOKEN_ISSUER_INVALID\") || ($.reasonCode = \"TOKEN_AUDIENCE_INVALID\") || ($.reasonCode = \"TOKEN_SIGNING_KEY_NOT_FOUND\") || ($.reasonCode = \"TOKEN_REPLAYED\") || ($.reasonCode = \"OIDC_STATE_OR_BROWSER_BINDING_INVALID\") || ($.reasonCode = \"OIDC_BROWSER_BINDING_MISSING\") }"
  metric_transformation {
    name      = "CriticalSecurityEvents"
    namespace = "SithsCarePilot/Security"
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "auth_failures" {
  alarm_name          = "${var.name}-authentication-failures"
  namespace           = "SithsCarePilot/Security"
  metric_name         = "AuthenticationFailures"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 10
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "security_events" {
  alarm_name          = "${var.name}-critical-security-events"
  namespace           = "SithsCarePilot/Security"
  metric_name         = "CriticalSecurityEvents"
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
}

locals {
  security_error_metrics = {
    internal_error = {
      code      = "INTERNAL_ERROR"
      metric    = "InternalErrors"
      threshold = 1
      period    = 60
    }
    origin_rejected = {
      code      = "ORIGIN_REJECTED"
      metric    = "OriginRejected"
      threshold = 5
      period    = 300
    }
    rate_limited = {
      code      = "RATE_LIMITED"
      metric    = "RateLimited"
      threshold = 20
      period    = 300
    }
  }
}

resource "aws_cloudwatch_log_metric_filter" "security_errors" {
  for_each       = local.security_error_metrics
  name           = "${var.name}-${each.key}"
  log_group_name = aws_cloudwatch_log_group.app.name
  pattern        = "{ $.category = \"siths_security_error\" && $.code = \"${each.value.code}\" }"

  metric_transformation {
    name      = each.value.metric
    namespace = "SithsCarePilot/Security"
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "security_errors" {
  for_each            = local.security_error_metrics
  alarm_name          = "${var.name}-${each.key}"
  namespace           = "SithsCarePilot/Security"
  metric_name         = each.value.metric
  statistic           = "Sum"
  period              = each.value.period
  evaluation_periods  = 1
  threshold           = each.value.threshold
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
}