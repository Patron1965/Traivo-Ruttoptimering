resource "aws_iam_role" "execution" {
  name = "${var.name}-execution"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "execution_secrets" {
  name = "read-runtime-secrets"
  role = aws_iam_role.execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = [local.oidc_secret_arn, local.readiness_secret_arn]
      },
      {
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = [aws_kms_key.data.arn]
      }
    ]
  })
}

resource "aws_iam_role" "task" {
  name = "${var.name}-task"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "task" {
  name = "pilot-runtime"
  role = aws_iam_role.task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "AuthRecords"
        Effect   = "Allow"
        Action   = ["dynamodb:DeleteItem", "dynamodb:DescribeTable", "dynamodb:DescribeTimeToLive", "dynamodb:GetItem", "dynamodb:PutItem"]
        Resource = aws_dynamodb_table.auth.arn
      },
      {
        Sid      = "AuditAppendAndRead"
        Effect   = "Allow"
        Action   = ["dynamodb:DescribeTable", "dynamodb:DescribeTimeToLive", "dynamodb:PutItem", "dynamodb:Query"]
        Resource = aws_dynamodb_table.audit.arn
      },
      {
        Sid      = "EnvelopeEncryption"
        Effect   = "Allow"
        Action   = ["kms:Decrypt", "kms:GenerateDataKey"]
        Resource = aws_kms_key.data.arn
      },
      {
        Sid      = "GenerateCurrentAuditMac"
        Effect   = "Allow"
        Action   = ["kms:GenerateMac"]
        Resource = local.current_audit_hmac_key_arn
      },
      {
        Sid      = "VerifyCurrentAndPreviousAuditMacs"
        Effect   = "Allow"
        Action   = ["kms:VerifyMac"]
        Resource = local.audit_hmac_verify_key_arns
      }
    ]
  })
}