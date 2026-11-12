resource "aws_cloudwatch_log_group" "app" {
  name              = "/aws/${var.name}/application"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.data.arn
}

resource "aws_ecs_cluster" "this" {
  name = var.name
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_lb" "this" {
  name                       = var.name
  load_balancer_type         = "application"
  internal                   = false
  security_groups            = [aws_security_group.alb.id]
  subnets                    = aws_subnet.public[*].id
  drop_invalid_header_fields = true
  enable_deletion_protection = true
}

resource "aws_lb_target_group" "app" {
  name        = var.name
  port        = 23756
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.this.id
  health_check {
    enabled             = true
    path                = "/siths-care-poc/api/siths/health"
    matcher             = "200"
    healthy_threshold   = 2
    unhealthy_threshold = 2
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}

resource "aws_ecs_task_definition" "app" {
  family                   = var.name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([{
    name                   = "broker"
    image                  = var.image_uri
    essential              = true
    readonlyRootFilesystem = true
    portMappings           = [{ containerPort = 23756, hostPort = 23756, protocol = "tcp" }]
    environment = [
      { name = "NODE_ENV", value = "production" },
      { name = "PORT", value = "23756" },
      { name = "BASE_PATH", value = "/siths-care-poc/" },
      { name = "SITHS_OIDC_PROFILE", value = var.oidc_profile },
      { name = "SITHS_OIDC_SCOPES", value = var.oidc_scopes },
      { name = "SITHS_STORE_BACKEND", value = "dynamodb" },
      { name = "SITHS_AWS_REGION", value = "eu-north-1" },
      { name = "SITHS_AUTH_TABLE", value = aws_dynamodb_table.auth.name },
      { name = "SITHS_AUDIT_TABLE", value = aws_dynamodb_table.audit.name },
      { name = "SITHS_AUTH_KMS_KEY_ARN", value = aws_kms_key.data.arn },
      { name = "SITHS_AUDIT_HMAC_KEY_ARN", value = local.current_audit_hmac_key_arn },
      { name = "SITHS_AUDIT_RETENTION_DAYS", value = tostring(var.audit_retention_days) },
      { name = "SITHS_AUDIT_HMAC_VERIFY_KEY_ARNS", value = join(",", local.audit_hmac_verify_key_arns) }
    ]
    secrets = concat([
      { name = "SITHS_OIDC_ISSUER", valueFrom = "${local.oidc_secret_arn}:issuer::" },
      { name = "SITHS_OIDC_CLIENT_ID", valueFrom = "${local.oidc_secret_arn}:clientId::" },
      { name = "SITHS_OIDC_CLIENT_SECRET", valueFrom = "${local.oidc_secret_arn}:clientSecret::" },
      { name = "SITHS_OIDC_REDIRECT_URI", valueFrom = "${local.oidc_secret_arn}:redirectUri::" },
      { name = "SITHS_OIDC_ALLOWED_METADATA_ORIGINS", valueFrom = "${local.oidc_secret_arn}:allowedMetadataOrigins::" },
      { name = "SITHS_READINESS_EVIDENCE_MANIFEST", valueFrom = "${local.readiness_secret_arn}:manifest::" }
    ], var.oidc_profile == "region-stockholm-test" ? [
      { name = "SITHS_OIDC_HSA_ID_CLAIM", valueFrom = "${local.oidc_secret_arn}:hsaIdClaim::" },
      { name = "SITHS_OIDC_LOA_CLAIM", valueFrom = "${local.oidc_secret_arn}:loaClaim::" },
      { name = "SITHS_OIDC_ACCEPTED_LOA_VALUES", valueFrom = "${local.oidc_secret_arn}:acceptedLoaValues::" },
      { name = "SITHS_OIDC_ASSIGNMENTS_CLAIM", valueFrom = "${local.oidc_secret_arn}:assignmentsClaim::" }
    ] : [])
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.app.name
        awslogs-region        = "eu-north-1"
        awslogs-stream-prefix = "broker"
      }
    }
  }])
}

resource "aws_ecs_service" "app" {
  name                               = var.name
  cluster                            = aws_ecs_cluster.this.id
  task_definition                    = aws_ecs_task_definition.app.arn
  desired_count                      = var.desired_count
  launch_type                        = "FARGATE"
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  enable_execute_command             = false
  health_check_grace_period_seconds  = 30

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.task.id]
    assign_public_ip = false
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.app.arn
    container_name   = "broker"
    container_port   = 23756
  }
  depends_on = [aws_lb_listener.https]
}

resource "aws_route53_record" "app" {
  count   = var.hosted_zone_id != null && var.domain_name != null ? 1 : 0
  zone_id = var.hosted_zone_id
  name    = var.domain_name
  type    = "A"
  alias {
    name                   = aws_lb.this.dns_name
    zone_id                = aws_lb.this.zone_id
    evaluate_target_health = true
  }

  lifecycle {
    precondition {
      condition     = (var.hosted_zone_id == null) == (var.domain_name == null)
      error_message = "hosted_zone_id and domain_name must be set together."
    }
  }
}